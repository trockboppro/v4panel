// Simple local file fetcher for server instances
const path = require("path");
const fs = require("fs-extra");
const sanitize = require("sanitize-filename");

/**
 * Fetch files in a given relative path inside the server's data folder.
 * @param {Object} instance - Instance object with ContainerId
 * @param {string} relPath - Relative path inside server folder
 * @returns {Promise<Array>} Array of file info { name, isDir, size }
 */
module.exports = async function fetchFiles(instance, relPath = "") {
    const safeRel = sanitize(relPath) || "";
    const basePath = path.join("/app/data", sanitize(String(instance.ContainerId)));
    const fullPath = path.join(basePath, safeRel);

    if (!await fs.pathExists(fullPath)) return [];

    const items = await fs.readdir(fullPath, { withFileTypes: true });
    const results = [];

    for (const item of items) {
        const stat = await fs.stat(path.join(fullPath, item.name));
        results.push({
            name: item.name,
            isDir: item.isDirectory(),
            size: stat.size
        });
    }

    return results;
};
