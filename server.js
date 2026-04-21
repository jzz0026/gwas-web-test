const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS || 2);
const PROCESSING_DELAY_MS = Number(process.env.PROCESSING_DELAY_MS || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const GWAS_RUNNER_IMAGE = process.env.GWAS_RUNNER_IMAGE || 'gwas-worker:latest';
const ARCHIVE_RETENTION_DAYS = Number(process.env.ARCHIVE_RETENTION_DAYS || 7);
const ARCHIVE_RETENTION_MS = ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const ARCHIVE_CLEANUP_INTERVAL_MS = Number(process.env.ARCHIVE_CLEANUP_INTERVAL_MS || 60 * 60 * 1000);
const EXAMPLE_GRAINS = {
    ecoli1: {
        label: 'E. coli 1',
        phenoFilePath: path.join(__dirname, 'gwasScripts', 'E_Coli_1', 'resistence.pheno')
    },
    ecoli2: {
        label: 'E. coli 2',
        phenoFilePath: path.join(__dirname, 'gwasScripts', 'E_Coli_2', 'resistence.pheno')
    }
};

function getExampleGrainConfig(grainKey) {
    if (!grainKey || typeof grainKey !== 'string') {
        return null;
    }

    return EXAMPLE_GRAINS[grainKey.toLowerCase()] || null;
}

// Middleware configuration
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// Create uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Multer configuration
const upload = multer({ dest: uploadsDir });

// Email configuration
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: process.env.SMTP_PORT || 587,
    secure: process.env.SMTP_SECURE === 'true' || false,
    auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    } : undefined
});

// Task storage (simple in-memory storage; use database in production)
const tasks = {};
const taskQueue = [];
const taskLogs = {};  // Store each task's logs
let activeTaskCount = 0;

function isTaskArchiveExpired(task) {
    if (!task || !task.archiveExpiresAt) {
        return false;
    }

    const expiresAtMs = new Date(task.archiveExpiresAt).getTime();
    if (Number.isNaN(expiresAtMs)) {
        return false;
    }

    return Date.now() >= expiresAtMs;
}

function clearTaskArchive(taskId, reason = 'expired') {
    const task = tasks[taskId];
    if (!task) {
        return;
    }

    if (task.archiveFilePath && fs.existsSync(task.archiveFilePath)) {
        try {
            fs.unlinkSync(task.archiveFilePath);
        } catch (error) {
            console.error(`[Task ${taskId}] Failed to delete archive file: ${error.message}`);
        }
    }

    task.archiveFilePath = null;
    task.archiveFileName = null;
    task.downloadUrl = null;
    task.archiveExpiresAt = null;

    if (reason === 'expired') {
        task.message = 'Archive expired after 7 days and was automatically deleted.';
    }
}

function cleanupExpiredArchives() {
    const now = Date.now();

    Object.values(tasks).forEach((task) => {
        if (!task || !task.id) {
            return;
        }

        if (isTaskArchiveExpired(task)) {
            console.log(`[Archive Cleanup] Expired archive removed for task ${task.id}`);
            clearTaskArchive(task.id, 'expired');
        }
    });

    // Best-effort cleanup for orphan archives not referenced in current in-memory tasks.
    try {
        const files = fs.readdirSync(uploadsDir);
        files
            .filter((name) => /^result_[a-f0-9-]+\.tar\.gz$/i.test(name))
            .forEach((name) => {
                const fullPath = path.join(uploadsDir, name);
                const stat = fs.statSync(fullPath);
                if (now - stat.mtimeMs >= ARCHIVE_RETENTION_MS) {
                    fs.unlinkSync(fullPath);
                    console.log(`[Archive Cleanup] Deleted orphan archive: ${name}`);
                }
            });
    } catch (error) {
        console.error(`[Archive Cleanup] Failed to scan uploads: ${error.message}`);
    }
}

/**
 * Create compressed archive for task output folder and copy to web uploads directory
 */
async function createTaskResultArchive(containerName, taskId) {
    const outputDirName = `output_${taskId}`;
    const outputDirInContainer = `/data/output/${outputDirName}`;
    const archiveFileName = `result_${taskId}.tar.gz`;
    const archiveInContainer = `/tmp/${archiveFileName}`;
    const archiveOnHost = path.join(uploadsDir, archiveFileName);

    if (fs.existsSync(archiveOnHost)) {
        fs.unlinkSync(archiveOnHost);
    }

    await runCommand('docker', ['exec', containerName, 'test', '-d', outputDirInContainer]);
    await runCommand('docker', ['exec', containerName, 'tar', '-czf', archiveInContainer, '-C', '/data/output', outputDirName]);

    try {
        await runCommand('docker', ['cp', `${containerName}:${archiveInContainer}`, archiveOnHost]);
    } finally {
        try {
            await runCommand('docker', ['exec', containerName, 'rm', '-f', archiveInContainer]);
        } catch (cleanupErr) {
            console.warn(`[Task ${taskId}] Failed to clean temp archive in container: ${cleanupErr.message}`);
        }
    }

    return {
        archiveFilePath: archiveOnHost,
        archiveFileName,
        downloadUrl: `${BASE_URL}/api/download/${taskId}`
    };
}

/**
 * Execute command (no shell; avoid injection risk)
 */
function runCommand(command, args = []) {
    return new Promise((resolve, reject) => {
        execFile(command, args, (error, stdout, stderr) => {
            if (error) {
                reject({
                    success: false,
                    message: error.message,
                    stderr,
                    stdout
                });
                return;
            }

            resolve({ success: true, stdout, stderr });
        });
    });
}

/**
 * Check whether a Docker container is currently running
 */
async function isContainerRunning(containerName) {
    const result = await runCommand('docker', ['inspect', '-f', '{{.State.Running}}', containerName]);
    return String(result.stdout || '').trim() === 'true';
}

/**
 * Get task queue position (1-based; 0 = not in queue)
 */
function getQueuePosition(taskId) {
    const index = taskQueue.indexOf(taskId);
    return index === -1 ? 0 : index + 1;
}

/**
 * Update queue positions for queued tasks
 */
function updateQueuedPositions() {
    taskQueue.forEach((id, index) => {
        if (tasks[id]) {
            tasks[id].queuePosition = index + 1;
            tasks[id].message = `Task queued, ${index} tasks ahead`;
        }
    });
}

/**
 * Sleep function for simulating GWAS processing time
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate target path; prevent directory traversal and dangerous characters
 */
function validateTargetPath(targetPath) {
    if (!targetPath || typeof targetPath !== 'string') {
        return { ok: false, message: 'Target path cannot be empty' };
    }

    const trimmed = targetPath.trim();
    if (!trimmed.startsWith('/')) {
        return { ok: false, message: 'Target path must be an absolute path (start with /)' };
    }

    if (trimmed.includes('..')) {
        return { ok: false, message: 'Target path cannot contain ..' };
    }

    if (!/^\/[a-zA-Z0-9_./-]*$/.test(trimmed)) {
        return { ok: false, message: 'Target path contains illegal characters' };
    }

    return { ok: true, value: trimmed };
}

/**
 * Validate and parse two-column table data
 */
function validateAndParseTableData(tableData) {
    if (!tableData || typeof tableData !== 'string') {
        return { ok: false, message: 'Table content cannot be empty' };
    }

    const lines = tableData
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    if (lines.length === 0) {
        return { ok: false, message: 'Table content cannot be empty' };
    }

    const rows = [];
    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const columns = rawLine.split(/\t|,/).map((col) => col.trim());

        if (columns.length !== 2) {
            return {
                ok: false,
                message: `Line ${i + 1} does not have exactly two columns`
            };
        }

        if (!columns[0] || !columns[1]) {
            return {
                ok: false,
                message: `Line ${i + 1} contains empty values`
            };
        }

        // Allow letters, numbers, spaces and common symbols; reject obvious command-injection characters
        const illegalPattern = /[;&|`$<>]/;
        if (illegalPattern.test(columns[0]) || illegalPattern.test(columns[1])) {
            return {
                ok: false,
                message: `Line ${i + 1} contains illegal characters (;&|\`$<>)`
            };
        }

        rows.push({ col1: columns[0], col2: columns[1] });
    }

    return { ok: true, rows, rowCount: rows.length };
}

/**
 * Execute cp command to Docker container
 */
async function executeCopyCommand(filePath, targetPath, containerName) {
    const remoteDir = targetPath.endsWith('/') ? targetPath : `${targetPath}/`;
    const remoteFilePath = path.posix.join(remoteDir, path.basename(filePath));

    console.log(`[Docker CP] Creating target directory: ${containerName}:${remoteDir}`);
    await runCommand('docker', ['exec', containerName, 'mkdir', '-p', remoteDir]);

    console.log(`[Docker CP] Executing command: docker cp ${filePath} ${containerName}:${remoteFilePath}`);
    const copyResult = await runCommand('docker', ['cp', filePath, `${containerName}:${remoteFilePath}`]);

    return {
        success: true,
        message: `File copied successfully to Docker container: ${remoteFilePath}`,
        stdout: copyResult.stdout,
        remoteFilePath
    };
}

/**
 * Execute GWAS script in Docker container
 */
async function executeRunnerTask(sharedContainerName, inputFilePath, taskId) {
    // Initialize task logs
    if (!taskLogs[taskId]) {
        taskLogs[taskId] = [];
    }

    const addLog = (message) => {
        const logEntry = `[${new Date().toLocaleTimeString()}] ${message}`;
        taskLogs[taskId].push(logEntry);
        console.log(`[GWAS Runner] ${logEntry}`);
    };

    const outputPath = `/data/output/output_${taskId}`;

    addLog(`Container name: ${sharedContainerName}`);
    addLog(`Input phenotype: ${inputFilePath}`);
    addLog(`Output directory: ${outputPath}`);
    addLog(`Execute: cd /opt/gwasScripts && bash ./06_run_gwas.sh 31 <uploaded_pheno_file> 4 <output_dir>`);
    addLog(`Starting GWAS analysis...`);

    return new Promise((resolve, reject) => {
        const escapedInputFilePath = String(inputFilePath).replace(/"/g, '\\"');
        const escapedOutputPath = String(outputPath).replace(/"/g, '\\"');
        // Execute script inside container after changing to script directory
        const child = require('child_process').exec(
            `docker exec ${sharedContainerName} bash -c "set -e; cd /opt/gwasScripts && bash ./06_run_gwas.sh 31 \"${escapedInputFilePath}\" 4 \"${escapedOutputPath}\""`,
            {
                maxBuffer: 20 * 1024 * 1024  // 20MB buffer
            },
            (error, stdout, stderr) => {
                if (error) {
                    addLog(`❌ Execution failed: ${error.message}`);
                    if (stderr) {
                        addLog(`Error log:\n${stderr}`);
                    }
                    reject({
                        success: false,
                        message: error.message,
                        stderr,
                        stdout
                    });
                    return;
                }

                addLog(`✅ Execution successful`);
                if (stdout) {
                    const lines = stdout.split('\n').filter(l => l.trim());
                    lines.forEach(line => addLog(`OUTPUT: ${line}`));
                }

                resolve({
                    success: true,
                    outputPath,
                    message: `GWAS analysis complete. Results at ${outputPath}`,
                    stdout
                });
            }
        );

        // Capture output in real time
        if (child.stdout) {
            child.stdout.on('data', (data) => {
                const lines = data.toString().split('\n').filter(l => l.trim());
                lines.forEach(line => addLog(`STDOUT: ${line}`));
            });
        }
        if (child.stderr) {
            child.stderr.on('data', (data) => {
                const lines = data.toString().split('\n').filter(l => l.trim());
                lines.forEach(line => addLog(`STDERR: ${line}`));
            });
        }
    });
}

/**
 * Send email notification
 */
async function sendNotificationEmail(email, taskId, taskName, status, message, downloadUrl = '') {
    const statusColor = status === 'success' ? 'green' : 'red';
    const statusText = status === 'success' ? '✅ Success' : '❌ Failed';
    
    const mailOptions = {
        from: process.env.SMTP_FROM || 'noreply@gwas.local',
        to: email,
        subject: `GWAS Task Notification - ${taskName} [${taskId}]`,
        html: `
            <h2>Task Processing Complete</h2>
            <p><strong>Task ID:</strong> ${taskId}</p>
            <p><strong>Task Name:</strong> ${taskName}</p>
            <p><strong>Status:</strong> <span style="color: ${statusColor};">${statusText}</span></p>
            <p><strong>Details:</strong> ${message}</p>
            ${downloadUrl ? `<p><a href="${downloadUrl}" style="background: #667eea; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">📥 Download Results</a></p>` : ''}
            <hr>
            <p style="color: #999; font-size: 12px;">This is an auto-generated email. Do not reply directly.</p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[Email] Sent to: ${email}`);
        return { success: true, message: 'Email sent' };
    } catch (error) {
        console.error(`[Email] Failed to send: ${error.message}`);
        return { success: false, message: `Failed to send email: ${error.message}` };
    }
}

/**
 * Send task-received confirmation email right after upload is accepted
 */
async function sendTaskReceivedEmail(email, taskId, taskName, status, queuePosition) {
    const statusLabel = status === 'running' ? 'Running' : 'Queued';
    const queueText = status === 'queued'
        ? `<p><strong>Queue Position:</strong> ${queuePosition}</p>`
        : '<p><strong>Queue Position:</strong> 0 (started immediately)</p>';

    const mailOptions = {
        from: process.env.SMTP_FROM || 'noreply@gwas.local',
        to: email,
        subject: `GWAS Task Received - ${taskName} [${taskId}]`,
        html: `
            <h2>Task Accepted</h2>
            <p>Your upload was received successfully and the task has been created.</p>
            <p><strong>Task ID:</strong> ${taskId}</p>
            <p><strong>Task Name:</strong> ${taskName}</p>
            <p><strong>Current Status:</strong> ${statusLabel}</p>
            ${queueText}
            <p><strong>Status API:</strong> <code>${BASE_URL}/api/status/${taskId}</code></p>
            <hr>
            <p style="color: #999; font-size: 12px;">This is an auto-generated confirmation email.</p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[Email] Upload confirmation sent to: ${email}`);
        return { success: true, message: 'Upload confirmation email sent' };
    } catch (error) {
        console.error(`[Email] Upload confirmation failed: ${error.message}`);
        return { success: false, message: `Failed to send upload confirmation email: ${error.message}` };
    }
}

async function processTask(taskId) {
    const task = tasks[taskId];
    if (!task) {
        return;
    }

    // Initialize task logs
    if (!taskLogs[taskId]) {
        taskLogs[taskId] = [];
    }

    task.status = 'running';
    task.stage = 'copy';
    task.progress = 35;
    task.queuePosition = 0;
    task.startedAt = new Date();
    task.message = 'Task started. Preparing data...';
    taskLogs[taskId].push(`[${new Date().toLocaleTimeString()}] ✅ Task started`);
    taskLogs[taskId].push(`[${new Date().toLocaleTimeString()}] Task ID: ${taskId}`);

    const containerName = process.env.DOCKER_CONTAINER || 'gwas-worker';

    try {
        // Start container only when it is not already running
        const containerRunning = await isContainerRunning(containerName);
        if (containerRunning) {
            taskLogs[taskId].push(`[${new Date().toLocaleTimeString()}] ℹ️ Docker container already running: ${containerName}`);
            console.log(`[Task ${taskId}] Docker container already running: ${containerName}`);
        } else {
            taskLogs[taskId].push(`[${new Date().toLocaleTimeString()}] 🚀 Starting Docker container: ${containerName}`);
            await runCommand('docker', ['start', containerName]);
            console.log(`[Task ${taskId}] Docker container started: ${containerName}`);
            taskLogs[taskId].push(`[${new Date().toLocaleTimeString()}] ✅ Docker container started`);
        }

        await sleep(Math.max(500, Math.floor(PROCESSING_DELAY_MS / 2)));
        task.progress = 60;
        task.message = 'Copying input file to shared data volume...';
        const copyResult = await executeCopyCommand(task.filePath, task.targetPath, containerName);

        task.stage = 'gwas';
        task.progress = 80;
        task.message = 'Running GWAS analysis script...';
        const runnerResult = await executeRunnerTask(containerName, copyResult.remoteFilePath, task.id);

        task.stage = 'archive';
        task.progress = 92;
        task.message = 'Compressing result folder for download...';
        taskLogs[taskId].push(`[${new Date().toLocaleTimeString()}] 📦 Compressing output folder...`);
        const archiveResult = await createTaskResultArchive(containerName, task.id);
        task.archiveFilePath = archiveResult.archiveFilePath;
        task.archiveFileName = archiveResult.archiveFileName;
        task.downloadUrl = archiveResult.downloadUrl;
        task.archiveExpiresAt = new Date(Date.now() + ARCHIVE_RETENTION_MS).toISOString();
        taskLogs[taskId].push(`[${new Date().toLocaleTimeString()}] ✅ Archive ready: ${archiveResult.archiveFileName}`);

        await sleep(Math.max(500, Math.floor(PROCESSING_DELAY_MS / 2)));
        task.status = 'completed';
        task.stage = 'done';
        task.progress = 100;
        task.processedRows = task.rowCount;
        task.completedAt = new Date();
        task.message = `✅ Completed: GWAS analysis succeeded. Archive retention: ${ARCHIVE_RETENTION_DAYS} days.`;

        await sendNotificationEmail(
            task.email,
            task.id,
            task.taskName,
            'success',
            `GWAS analysis completed successfully. Processed ${task.rowCount} rows. Results at ${runnerResult.outputPath}.`,
            archiveResult.downloadUrl
        );

        console.log(`[Task ${task.id}] ✅ Completed`);
    } catch (error) {
        task.status = 'failed';
        task.stage = 'failed';
        task.progress = 100;
        task.completedAt = new Date();
        task.message = `❌ Task failed: ${error.message || 'Unknown error'}`;

        await sendNotificationEmail(
            task.email,
            task.id,
            task.taskName,
            'failed',
            `Task processing failed: ${error.message || 'Unknown error'}`
        );

        console.error(`[Task ${task.id}] ❌ Failed:`, error);
    } finally {
        // Stop container
        try {
            const hasOtherRunningTasks = Object.values(tasks).some(
                (t) => t && t.id !== taskId && t.status === 'running'
            );
            const hasQueuedTasks = taskQueue.length > 0;

            if (hasOtherRunningTasks || hasQueuedTasks) {
                const keepRunningMsg = `[${new Date().toLocaleTimeString()}] ℹ️ Keep Docker container running: active or queued task(s) still exist`;
                taskLogs[taskId].push(keepRunningMsg);
                console.log(`[Task ${taskId}] Skip stop: active or queued tasks still exist`);
            } else {
                taskLogs[taskId].push(`[${new Date().toLocaleTimeString()}] ⛔ Stopping Docker container: ${containerName}`);
                await runCommand('docker', ['stop', containerName]);
                console.log(`[Task ${taskId}] Docker container stopped: ${containerName}`);
                taskLogs[taskId].push(`[${new Date().toLocaleTimeString()}] ✅ Docker container stopped`);
            }
        } catch (err) {
            console.error(`[Task ${taskId}] Failed to stop container:`, err);
        }

        if (task.filePath && fs.existsSync(task.filePath)) {
            try {
                fs.unlinkSync(task.filePath);
                console.log(`[Task ${task.id}] Temporary file cleaned up`);
            } catch (e) {
                console.error(`[Task ${task.id}] Failed to clean up file: ${e.message}`);
            }
        }
    }
}

function tryStartQueuedTasks() {
    while (activeTaskCount < MAX_CONCURRENT_TASKS && taskQueue.length > 0) {
        const nextTaskId = taskQueue.shift();
        const nextTask = tasks[nextTaskId];

        if (!nextTask || nextTask.status !== 'queued') {
            continue;
        }

        activeTaskCount += 1;
        updateQueuedPositions();

        processTask(nextTaskId)
            .catch((error) => {
                console.error(`[Task ${nextTaskId}] Processing exception:`, error);
            })
            .finally(() => {
                activeTaskCount = Math.max(0, activeTaskCount - 1);
                updateQueuedPositions();
                tryStartQueuedTasks();
            });
    }
}

/**
 * API route: upload and process
 */
app.post('/api/upload', async (req, res) => {
    try {
        const { email, targetPath, taskName, tableData, rowCount } = req.body;
        const taskId = uuidv4();

        // Validate input
        if (!email || !targetPath || !tableData) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        const targetPathValidation = validateTargetPath(targetPath);
        if (!targetPathValidation.ok) {
            return res.status(400).json({
                success: false,
                message: targetPathValidation.message
            });
        }

        const tableValidation = validateAndParseTableData(tableData);
        if (!tableValidation.ok) {
            return res.status(400).json({
                success: false,
                message: tableValidation.message
            });
        }

        // Save task metadata
        tasks[taskId] = {
            id: taskId,
            email,
            targetPath: targetPathValidation.value,
            taskName: taskName || 'Untitled Task',
            status: 'queued',
            stage: 'queue',
            queuePosition: taskQueue.length + 1,
            createdAt: new Date(),
            rowCount: tableValidation.rowCount || rowCount || 0,
            processedRows: 0,
            progress: 0,
            archiveFilePath: null,
            archiveFileName: null,
            downloadUrl: null,
            archiveExpiresAt: null,
            message: `Task received. ${taskQueue.length} task(s) ahead in queue`
        };

        // Generate temporary input file
        const fileName = `table_${taskId}.csv`;
        const filePath = path.join(uploadsDir, fileName);
        
        fs.writeFileSync(filePath, tableData);
        tasks[taskId].filePath = filePath;
        console.log(`[Task ${taskId}] File saved: ${filePath}`);

        // Enqueue then trigger scheduler
        taskQueue.push(taskId);
        updateQueuedPositions();
        tryStartQueuedTasks();

        // Send immediate confirmation email once task is accepted
        const acceptedTask = tasks[taskId];
        const acceptedStatus = acceptedTask?.status || 'queued';
        const acceptedQueuePosition = acceptedStatus === 'queued' ? getQueuePosition(taskId) : 0;
        await sendTaskReceivedEmail(
            email,
            taskId,
            acceptedTask?.taskName || 'Untitled Task',
            acceptedStatus,
            acceptedQueuePosition
        );

        // Return response immediately
        res.json({
            success: true,
            taskId,
            status: tasks[taskId].status,
            queuePosition: tasks[taskId].queuePosition,
            activeTaskCount,
            queuedTaskCount: taskQueue.length,
            message: 'Task received and queued for processing...'
        });

    } catch (error) {
        console.error(`[API] Error: ${error.message}`);
        res.status(500).json({
            success: false,
            message: `Server error: ${error.message}`
        });
    }
});

/**
 * API route: query task status
 */
app.get('/api/status/:taskId', (req, res) => {
    const { taskId } = req.params;
    const task = tasks[taskId];

    if (!task) {
        return res.status(404).json({
            success: false,
            message: 'Task not found'
        });
    }

    res.json({
        success: true,
        task: {
            id: task.id,
            status: task.status,
            stage: task.stage,
            progress: task.progress,
            taskName: task.taskName,
            rowCount: task.rowCount,
            processedRows: task.processedRows,
            queuePosition: task.status === 'queued' ? getQueuePosition(task.id) : 0,
            downloadUrl: task.downloadUrl || null,
            archiveReady: Boolean(task.archiveFilePath && fs.existsSync(task.archiveFilePath)),
            archiveExpiresAt: task.archiveExpiresAt || null,
            archiveRetentionDays: ARCHIVE_RETENTION_DAYS,
            message: task.message,
            createdAt: task.createdAt,
            startedAt: task.startedAt || null,
            completedAt: task.completedAt || null
        }
    });
});

/**
 * API route: queue overview
 */
app.get('/api/queue', (req, res) => {
    const runningTasks = Object.values(tasks)
        .filter((task) => task && task.status === 'running')
        .map((task) => ({
            id: task.id,
            taskName: task.taskName,
            email: task.email,
            stage: task.stage,
            progress: task.progress,
            rowCount: task.rowCount,
            processedRows: task.processedRows,
            startedAt: task.startedAt || null,
            message: task.message
        }));

    const queuedTasks = taskQueue
        .map((taskId, index) => {
            const task = tasks[taskId];
            if (!task) {
                return null;
            }

            return {
                id: task.id,
                taskName: task.taskName,
                email: task.email,
                rowCount: task.rowCount,
                queuePosition: index + 1,
                createdAt: task.createdAt || null,
                message: task.message
            };
        })
        .filter(Boolean);

    res.json({
        success: true,
        activeTaskCount,
        maxConcurrentTasks: MAX_CONCURRENT_TASKS,
        runningTaskCount: runningTasks.length,
        queuedTaskCount: taskQueue.length,
        queuedTaskIds: [...taskQueue],
        runningTasks,
        queuedTasks
    });
});

/**
 * API route: list available example grains
 */
app.get('/api/examples', (req, res) => {
    const examples = Object.entries(EXAMPLE_GRAINS).map(([key, value]) => ({
        key,
        label: value.label,
        phenoPath: value.phenoFilePath
    }));

    res.json({
        success: true,
        examples
    });
});

/**
 * API route: fetch example phenotype file
 */
app.get('/api/examples/:grain/pheno', (req, res) => {
    const example = getExampleGrainConfig(req.params.grain);

    if (!example) {
        return res.status(404).json({
            success: false,
            message: 'Example grain not found'
        });
    }

    if (!fs.existsSync(example.phenoFilePath)) {
        return res.status(404).json({
            success: false,
            message: `Example file not found: ${example.phenoFilePath}`
        });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(fs.readFileSync(example.phenoFilePath, 'utf8'));
});

/**
 * API route: download example phenotype file
 */
app.get('/api/examples/:grain/download', (req, res) => {
    const example = getExampleGrainConfig(req.params.grain);

    if (!example) {
        return res.status(404).json({
            success: false,
            message: 'Example grain not found'
        });
    }

    if (!fs.existsSync(example.phenoFilePath)) {
        return res.status(404).json({
            success: false,
            message: `Example file not found: ${example.phenoFilePath}`
        });
    }

    res.setHeader('Content-Type', 'text/tab-separated-values; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.grain}_resistence.pheno"`);
    res.send(fs.readFileSync(example.phenoFilePath, 'utf8'));
});

/**
 * API route: download archived task result
 */
app.get('/api/download/:taskId', (req, res) => {
    const { taskId } = req.params;
    const task = tasks[taskId];

    if (!task) {
        return res.status(404).json({
            success: false,
            message: 'Task not found'
        });
    }

    if (task.status !== 'completed') {
        return res.status(400).json({
            success: false,
            message: `Task is not completed. Current status: ${task.status}`
        });
    }

    if (isTaskArchiveExpired(task)) {
        clearTaskArchive(taskId, 'expired');
        return res.status(410).json({
            success: false,
            message: `Archive expired after ${ARCHIVE_RETENTION_DAYS} days and was automatically deleted`
        });
    }

    if (!task.archiveFilePath || !fs.existsSync(task.archiveFilePath)) {
        return res.status(404).json({
            success: false,
            message: 'Archived result file not found for this task'
        });
    }

    res.download(task.archiveFilePath, task.archiveFileName || `result_${taskId}.tar.gz`);
});

/**
 * API route: view task logs
 */
app.get('/api/logs/:taskId', (req, res) => {
    const { taskId } = req.params;
    const task = tasks[taskId];

    if (!task) {
        return res.status(404).json({
            success: false,
            message: 'Task not found'
        });
    }

    const logs = taskLogs[taskId] || [];

    res.json({
        success: true,
        taskId,
        status: task.status,
        stage: task.stage,
        progress: task.progress,
        message: task.message,
        logs: logs,
        logCount: logs.length
    });
});

/**
 * Task detail page route
 */
app.get('/task/:taskId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'task.html'));
});

/**
 * Health check
 */
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date() });
});

/**
 * Start server
 */
app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`🚀 GWAS Web service started`);
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`📧 Email service: ${process.env.SMTP_HOST || 'not configured'}`);
    console.log(`🐳 Docker container: ${process.env.DOCKER_CONTAINER || 'not specified'}`);
    console.log(`🧬 Runner image: ${GWAS_RUNNER_IMAGE}`);
    console.log(`⏱️  Max concurrent tasks: ${MAX_CONCURRENT_TASKS}`);
    console.log(`🧪 Demo delay (instead of real GWAS): ${PROCESSING_DELAY_MS}ms`);
    console.log(`🗃️  Archive retention: ${ARCHIVE_RETENTION_DAYS} days`);
    console.log(`========================================\n`);

    cleanupExpiredArchives();
    setInterval(cleanupExpiredArchives, ARCHIVE_CLEANUP_INTERVAL_MS);
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});
