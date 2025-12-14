const express = require("express");
const router = express.Router();
const { db } = require("../../handlers/db.js");
const {
    isUserAuthorizedForContainer,
    isInstanceSuspended,
} = require("../../utils/authHelper.js");
const log = new (require("cat-loggr"))();
const { loadPlugins } = require("../../plugins/loadPls.js");
const path = require("path");
const fs = require("fs");
const schedule = require("node-schedule");
const axios = require("axios");

const plugins = loadPlugins(path.join(__dirname, "../../plugins"));
const workflowsFilePath = path.join(__dirname, "../../storage/workflows.json");
const scheduledWorkflowsFilePath = path.join(__dirname, "../../storage/scheduledWorkflows.json");

function saveWorkflowToFile(instanceId, workflow) {
    try {
        let workflows = {};

        if (fs.existsSync(workflowsFilePath)) {
            const data = fs.readFileSync(workflowsFilePath, "utf8");
            workflows = JSON.parse(data);
        }

        workflows[instanceId] = workflow;

        fs.writeFileSync(workflowsFilePath, JSON.stringify(workflows, null, 2), "utf8");
    } catch (error) {
        log.error("Error saving workflow to file:", error);
    }
}

function loadWorkflowFromFile(instanceId) {
    try {
        if (!fs.existsSync(workflowsFilePath)) return null;

        const data = fs.readFileSync(workflowsFilePath, "utf8");
        const workflows = JSON.parse(data);
        return workflows[instanceId] || null;
    } catch (error) {
        log.error("Error loading workflow from file:", error);
        return null;
    }
}

function saveScheduledWorkflows() {
    try {
        const scheduledWorkflows = {};

        for (const job of Object.values(schedule.scheduledJobs)) {
            if (job.name.startsWith("job_")) {
                const instanceId = job.name.split("_")[1];
                scheduledWorkflows[instanceId] = job.nextInvocation();
            }
        }

        fs.writeFileSync(scheduledWorkflowsFilePath, JSON.stringify(scheduledWorkflows, null, 2), "utf8");
    } catch (error) {
        log.error("Error saving scheduled workflows:", error);
    }
}

function loadScheduledWorkflows() {
    try {
        if (fs.existsSync(scheduledWorkflowsFilePath)) {
            const data = fs.readFileSync(scheduledWorkflowsFilePath, "utf8");
            const scheduledWorkflows = JSON.parse(data);

            for (const [instanceId] of Object.entries(scheduledWorkflows)) {
                const workflow = loadWorkflowFromFile(instanceId);
                if (workflow) {
                    scheduleWorkflowExecution(instanceId, workflow);
                }
            }
        }
    } catch (error) {
        log.error("Error loading scheduled workflows:", error);
    }
}

// 🛠 FIXED: Wrapped entire logic inside try-catch
router.get("/instance/:id/automations", async (req, res) => {
    try {
        if (!req.user) return res.redirect("/");

        const { id } = req.params;
        if (!id) return res.redirect("../instances");

        const instance = await db.get(id + "_instance").catch((err) => {
            log.error("Failed to fetch instance:", err);
            return null;
        });

        if (!instance) return res.status(404).send("Instance not found");

        const isAuthorized = await isUserAuthorizedForContainer(req.user.userId, instance.Id);
        if (!isAuthorized) return res.status(403).send("Unauthorized access to this instance.");

        const suspended = await isInstanceSuspended(req.user.userId, instance, id);
        if (suspended === true) {
            return res.render("instance/suspended", { req, user: req.user });
        }

        let workflow = await db.get(id + "_workflow");
        if (!workflow) {
            workflow = loadWorkflowFromFile(id);
        }

        if (!workflow) {
            workflow = {};
        }

        const allPluginData = Object.values(plugins).map((plugin) => plugin.config);

        // 🛠 FIXED: Defined missing variables
        const port = instance.Port || 8080;
        const domain = instance.Domain || "localhost";
        const files = instance.Files || [];

        res.render("instance/automations", {
            req,
            ContainerId: instance.ContainerId,
            instance,
            port,
            domain,
            user: req.user,
            name: (await db.get("name")) || "TeryxPanel",
            logo: (await db.get("logo")) || false,
            files,
            addons: {
                plugins: allPluginData,
            },
        });
    } catch (error) {
        log.error("Error in instance/automations route:", error);
        res.status(500).render("error", {
            error: "Internal Server Error",
            user: req.user,
            name: (await db.get("name")) || "TeryxPanel",
            logo: (await db.get("logo")) || false,
        });
    }
});

module.exports = router;
