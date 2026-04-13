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
        // Start container
        taskLogs[taskId].push(`[${new Date().toLocaleTimeString()}] 🚀 Starting Docker container: ${containerName}`);
        await runCommand('docker', ['start', containerName]);
        console.log(`[Task ${taskId}] Docker container started: ${containerName}`);
        taskLogs[taskId].push(`[${new Date().toLocaleTimeString()}] ✅ Docker container started`);

        await sleep(Math.max(500, Math.floor(PROCESSING_DELAY_MS / 2)));
        task.progress = 60;
        task.message = 'Copying input file to shared data volume...';
        const copyResult = await executeCopyCommand(task.filePath, task.targetPath, containerName);

        task.stage = 'gwas';
        task.progress = 80;
        task.message = 'Running GWAS analysis script...';
        const runnerResult = await executeRunnerTask(containerName, copyResult.remoteFilePath, task.id);

        await sleep(Math.max(500, Math.floor(PROCESSING_DELAY_MS / 2)));
        task.status = 'completed';
        task.stage = 'done';
        task.progress = 100;
        task.processedRows = task.rowCount;
        task.completedAt = new Date();
        task.message = `✅ Completed: GWAS analysis succeeded. Results at ${runnerResult.outputPath || runnerResult.outputDir}`;

        await sendNotificationEmail(
            task.email,
            task.id,
            task.taskName,
            'success',
            `GWAS analysis completed successfully. Processed ${task.rowCount} rows. Results at ${runnerResult.outputPath}.`,
            `${BASE_URL}/api/download/${task.id}`
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
            taskLogs[taskId].push(`[${new Date().toLocaleTimeString()}] ⛔ Stopping Docker container: ${containerName}`);
            await runCommand('docker', ['stop', containerName]);
            console.log(`[Task ${taskId}] Docker container stopped: ${containerName}`);
            taskLogs[taskId].push(`[${new Date().toLocaleTimeString()}] ✅ Docker container stopped`);
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
    res.json({
        success: true,
        activeTaskCount,
        maxConcurrentTasks: MAX_CONCURRENT_TASKS,
        queuedTaskCount: taskQueue.length,
        queuedTaskIds: [...taskQueue]
    });
});

/**
 * API route: download result (demo)
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

    // Generate result file (demo: simple text file)
    const resultContent = `GWAS Processing Result\n=================================\nTask ID: ${taskId}\nTask Name: ${task.taskName}\nProcessed Rows: ${task.processedRows}\nStatus: ${task.status}\nCompleted At: ${new Date().toLocaleString()}\n\nDetails:\n${task.message}`;
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="result_${taskId}.txt"`);
    res.send(resultContent);
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
    console.log(`========================================\n`);
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});
