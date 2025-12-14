const express = require('express');
const axios = require('axios');
const router = express.Router();
const { db } = require('../../handlers/db');
const { isUserAuthorizedForContainer } = require('../../utils/authHelper');
const { fetchFiles } = require('../../utils/fileHelper');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const CURSEFORGE_API = 'https://api.curseforge.com/v1';
const ITEMS_PER_PAGE = 12;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes cache

const modpackCache = new Map();

// Helper function to fetch from Modrinth API
async function fetchModrinthModpacks(page = 1, query = '', gameVersion = '') {
    try {
        let url = `${MODRINTH_API}/search?limit=${ITEMS_PER_PAGE}&offset=${(page - 1) * ITEMS_PER_PAGE}&facets=[[%22project_type:modpack%22]]`;
        
        if (query) {
            url += `&query=${encodeURIComponent(query)}`;
        }
        
        if (gameVersion) {
            url += `&facets=[[%22versions:${gameVersion}%22]]`;
        }

        const response = await axios.get(url);
        return response.data.hits.map(modpack => ({
            id: modpack.project_id,
            platform: 'modrinth',
            name: modpack.title,
            author: modpack.author,
            description: modpack.description,
            downloads: modpack.downloads,
            icon_url: modpack.icon_url,
            banner_url: modpack.gallery?.[0]?.url || null,
            versions: modpack.versions,
            tags: modpack.categories,
            date_created: new Date(modpack.date_created).toLocaleDateString(),
            date_updated: new Date(modpack.date_updated).toLocaleDateString()
        }));
    } catch (error) {
        console.error('Modrinth API Error:', error.message);
        return [];
    }
}

// Helper function to fetch from CurseForge API
async function fetchCurseForgeModpacks(page = 1, query = '', gameVersion = '') {
    try {
        const params = {
            gameId: 432, // Minecraft
            pageSize: ITEMS_PER_PAGE,
            index: (page - 1) * ITEMS_PER_PAGE,
            categoryId: 4471, // Modpacks category
            sortField: 2, // Sort by popularity
            sortOrder: 'desc'
        };

        if (query) {
            params.searchFilter = query;
        }

        if (gameVersion) {
            params.gameVersion = gameVersion;
        }

        const response = await axios.get(`${CURSEFORGE_API}/mods/search`, {
            params,
            headers: {
                'x-api-key': process.env.CURSEFORGE_API_KEY || ''
            }
        });

        return response.data.data.map(modpack => ({
            id: modpack.id.toString(),
            platform: 'curseforge',
            name: modpack.name,
            author: modpack.authors?.[0]?.name || 'Unknown',
            description: modpack.summary,
            downloads: modpack.downloadCount,
            icon_url: modpack.logo?.url || null,
            banner_url: modpack.screenshots?.[0]?.url || null,
            versions: modpack.latestFilesIndexes?.map(file => ({
                id: file.fileId.toString(),
                name: file.filename,
                game_versions: file.gameVersions
            })) || [],
            tags: modpack.categories?.map(cat => cat.name) || [],
            date_created: modpack.dateCreated ? new Date(modpack.dateCreated).toLocaleDateString() : 'Unknown',
            date_updated: modpack.dateModified ? new Date(modpack.dateModified).toLocaleDateString() : 'Unknown'
        }));
    } catch (error) {
        console.error('CurseForge API Error:', error.message);
        return [];
    }
}

// Main modpack listing endpoint
router.get('/instance/:id/modpacks', async (req, res) => {
    try {
        if (!req.user) return res.redirect('/');

        const { id } = req.params;
        if (!id) return res.redirect('/');

        const instance = await db.get(`${id}_instance`);
        if (!instance) return res.redirect('../instances');

        const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
        if (!isAuthorized) return res.status(403).send('Unauthorized');

        if (instance.suspended) return res.redirect('../../instances?err=SUSPENDED');

        const config = require('../../config.json');
        const { port, domain } = config;
        const platform = req.query.platform || 'all';
        const searchQuery = req.query.q || '';
        const gameVersion = req.query.gameVersion || '';
        const page = parseInt(req.query.page) || 1;
        const cacheKey = `modpacks_${platform}_${searchQuery}_${gameVersion}_${page}`;

        // Check cache
        let modpacks = [];
        if (modpackCache.has(cacheKey)) {
            const cached = modpackCache.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_TTL) {
                modpacks = cached.data;
            }
        }

        // Fetch fresh data if cache is empty or expired
        if (modpacks.length === 0) {
            const [modrinthModpacks, curseforgeModpacks] = await Promise.all([
                (platform === 'all' || platform === 'modrinth') ? 
                    fetchModrinthModpacks(page, searchQuery, gameVersion) : 
                    Promise.resolve([]),
                (platform === 'all' || platform === 'curseforge') ? 
                    fetchCurseForgeModpacks(page, searchQuery, gameVersion) : 
                    Promise.resolve([])
            ]);

            modpacks = [...modrinthModpacks, ...curseforgeModpacks]
                .sort((a, b) => b.downloads - a.downloads);

            modpackCache.set(cacheKey, {
                data: modpacks,
                timestamp: Date.now()
            });
        }

        res.render('instance/modpack_installer', {
            req,
            instance,
            port,
            domain,
            user: req.user,
            name: (await db.get('name')) || 'TeryxPanel',
            logo: (await db.get('logo')) || false,
            files: await fetchFiles(instance, ''),
            modpacks,
            addons: { plugins: [] }, // Required for template compatibility
            currentPage: page,
            hasMore: modpacks.length >= ITEMS_PER_PAGE
        });

    } catch (error) {
        console.error('Modpack Installer Error:', error);
        res.status(500).render('error', {
            error: 'Failed to load modpacks. Please try again later.'
        });
    }
});

// Modpack versions endpoint
router.get('/instance/:id/modpacks/versions', async (req, res) => {
    try {
        const { platform, modpackId } = req.query;
        if (!platform || !modpackId) {
            return res.status(400).json({ error: 'Missing platform or modpackId' });
        }

        let versions = [];
        
        if (platform === 'modrinth') {
            const response = await axios.get(`${MODRINTH_API}/project/${modpackId}/version`);
            versions = response.data.map(v => ({
                id: v.id,
                name: v.version_number,
                game_versions: v.game_versions,
                download_url: v.files[0]?.url,
                size: v.files[0]?.size,
                date: new Date(v.date_published).toLocaleDateString()
            }));
        } else if (platform === 'curseforge') {
            const response = await axios.get(`${CURSEFORGE_API}/mods/${modpackId}/files`, {
                headers: { 'x-api-key': process.env.CURSEFORGE_API_KEY || '' }
            });
            versions = response.data.data.map(v => ({
                id: v.id.toString(),
                name: v.displayName,
                game_versions: v.gameVersions,
                download_url: v.downloadUrl,
                size: v.fileLength,
                date: new Date(v.fileDate).toLocaleDateString()
            }));
        }

        res.json(versions);
    } catch (error) {
        console.error('Version Fetch Error:', error);
        res.status(500).json({ error: 'Failed to fetch versions' });
    }
});

// Modpack download endpoint
router.get('/instance/:id/modpacks/download', async (req, res) => {
    try {
        if (!req.user) return res.redirect('/');
        
        const { id } = req.params;
        const { platform, modpackId, versionId, modpackName } = req.query;
        
        if (!id || !platform || !modpackId || !versionId || !modpackName) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }

        const instance = await db.get(`${id}_instance`);
        if (!instance) return res.redirect('../instances');

        const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
        if (!isAuthorized) return res.status(403).send('Unauthorized');

        if (instance.suspended) return res.redirect('../../instances?err=SUSPENDED');

        // Get the download URL for the specific version
        let downloadUrl;
        if (platform === 'modrinth') {
            const response = await axios.get(`${MODRINTH_API}/version/${versionId}`);
            downloadUrl = response.data.files[0]?.url;
            if (!downloadUrl) throw new Error('No download URL found for Modrinth modpack');
        } else if (platform === 'curseforge') {
            const response = await axios.get(`${CURSEFORGE_API}/mods/${modpackId}/files/${versionId}/download-url`, {
                headers: { 'x-api-key': process.env.CURSEFORGE_API_KEY || '' }
            });
            downloadUrl = response.data.data;
            if (!downloadUrl) throw new Error('No download URL found for CurseForge modpack');
        }

        // Sanitize filename
        const safeName = modpackName.replace(/[^\w-]/g, '').slice(0, 50);
        const fileName = `${safeName}-${versionId}.zip`;

        // Prepare download request
        const request = {
            method: 'post',
            url: `http://${instance.Node.address}:${instance.Node.port}/fs/${instance.VolumeId}/files/mods/${encodeURIComponent(downloadUrl)}/${fileName}`,
            auth: {
                username: 'Skyport',
                password: instance.Node.apiKey
            },
            headers: { 'Content-Type': 'application/json' },
            data: {}
        };

        // Execute download
        const response = await axios(request);
        if (response.status === 200) {
            return res.redirect(`/instance/${id}/modpacks?success=true`);
        } else {
            throw new Error('Server returned non-200 status');
        }

    } catch (error) {
        console.error('Download Error:', error);
        return res.status(500).json({ 
            error: 'Download failed',
            details: error.response?.data || error.message
        });
    }
});

module.exports = router;