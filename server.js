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

// 中间件配置
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// 创建上传目录
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Multer 配置
const upload = multer({ dest: uploadsDir });

// 邮件配置
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: process.env.SMTP_PORT || 587,
    secure: process.env.SMTP_SECURE === 'true' || false,
    auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    } : undefined
});

// 任务存储（简单的内存存储，生产环境应使用数据库）
const tasks = {};
const taskQueue = [];
const taskLogs = {};  // 存储每个任务的日志
let activeTaskCount = 0;

/**
 * 执行命令（无 shell，避免注入风险）
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
 * 获取任务排队位置（从 1 开始，0 代表不在队列中）
 */
function getQueuePosition(taskId) {
    const index = taskQueue.indexOf(taskId);
    return index === -1 ? 0 : index + 1;
}

/**
 * 更新队列中任务的排队位置
 */
function updateQueuedPositions() {
    taskQueue.forEach((id, index) => {
        if (tasks[id]) {
            tasks[id].queuePosition = index + 1;
            tasks[id].message = `任务排队中，前方还有 ${index} 个任务`;
        }
    });
}

/**
 * 睡眠函数，用于模拟 GWAS 处理耗时
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 验证目标路径，避免目录穿越和危险字符
 */
function validateTargetPath(targetPath) {
    if (!targetPath || typeof targetPath !== 'string') {
        return { ok: false, message: '目标路径不能为空' };
    }

    const trimmed = targetPath.trim();
    if (!trimmed.startsWith('/')) {
        return { ok: false, message: '目标路径必须是绝对路径（以 / 开头）' };
    }

    if (trimmed.includes('..')) {
        return { ok: false, message: '目标路径不能包含 ..' };
    }

    if (!/^\/[a-zA-Z0-9_./-]*$/.test(trimmed)) {
        return { ok: false, message: '目标路径包含非法字符' };
    }

    return { ok: true, value: trimmed };
}

/**
 * 验证并解析两列表格
 */
function validateAndParseTableData(tableData) {
    if (!tableData || typeof tableData !== 'string') {
        return { ok: false, message: '表格内容不能为空' };
    }

    const lines = tableData
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    if (lines.length === 0) {
        return { ok: false, message: '表格内容不能为空' };
    }

    const rows = [];
    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const columns = rawLine.split(/\t|,/).map((col) => col.trim());

        if (columns.length !== 2) {
            return {
                ok: false,
                message: `第 ${i + 1} 行不是两列数据，请确保每行恰好两列`
            };
        }

        if (!columns[0] || !columns[1]) {
            return {
                ok: false,
                message: `第 ${i + 1} 行存在空值，请补全两列`
            };
        }

        // 允许字母、数字、空格和常见符号，拒绝明显命令注入字符
        const illegalPattern = /[;&|`$<>]/;
        if (illegalPattern.test(columns[0]) || illegalPattern.test(columns[1])) {
            return {
                ok: false,
                message: `第 ${i + 1} 行包含非法字符（;&|\`$<>）`
            };
        }

        rows.push({ col1: columns[0], col2: columns[1] });
    }

    return { ok: true, rows, rowCount: rows.length };
}

/**
 * 执行 cp 命令到 Docker 容器
 */
async function executeCopyCommand(filePath, targetPath, containerName) {
    const remoteDir = targetPath.endsWith('/') ? targetPath : `${targetPath}/`;
    const remoteFilePath = path.posix.join(remoteDir, path.basename(filePath));

    console.log(`[Docker CP] 创建目标目录: ${containerName}:${remoteDir}`);
    await runCommand('docker', ['exec', containerName, 'mkdir', '-p', remoteDir]);

    console.log(`[Docker CP] 执行命令: docker cp ${filePath} ${containerName}:${remoteFilePath}`);
    const copyResult = await runCommand('docker', ['cp', filePath, `${containerName}:${remoteFilePath}`]);

    return {
        success: true,
        message: `文件已成功复制到 Docker 容器: ${remoteFilePath}`,
        stdout: copyResult.stdout,
        remoteFilePath
    };
}

/**
 * 执行 GWAS 脚本（在 Docker 容器中执行）
 */
async function executeRunnerTask(sharedContainerName, inputFilePath, taskId) {
    // 初始化日志
    if (!taskLogs[taskId]) {
        taskLogs[taskId] = [];
    }

    const addLog = (message) => {
        const logEntry = `[${new Date().toLocaleTimeString()}] ${message}`;
        taskLogs[taskId].push(logEntry);
        console.log(`[GWAS Runner] ${logEntry}`);
    };

    const outputPath = `/data/output/output_${taskId}`;

    addLog(`容器名称: ${sharedContainerName}`);
    addLog(`输入 phenotype 文件: ${inputFilePath}`);
    addLog(`结果目录: ${outputPath}`);
    addLog(`在容器中执行命令: cd /opt/gwasScripts && bash ./06_run_gwas.sh 31 <uploaded_pheno_file> 4 <output_dir>`);
    addLog(`开始执行GWAS分析...`);

    return new Promise((resolve, reject) => {
        const escapedInputFilePath = String(inputFilePath).replace(/"/g, '\\"');
        const escapedOutputPath = String(outputPath).replace(/"/g, '\\"');
        // 在容器中执行脚本，先 cd 到脚本目录
        const child = require('child_process').exec(
            `docker exec ${sharedContainerName} bash -c "set -e; cd /opt/gwasScripts && bash ./06_run_gwas.sh 31 \"${escapedInputFilePath}\" 4 \"${escapedOutputPath}\""`,
            {
                maxBuffer: 20 * 1024 * 1024  // 20MB 缓冲区
            },
            (error, stdout, stderr) => {
                if (error) {
                    addLog(`❌ 执行失败: ${error.message}`);
                    if (stderr) {
                        addLog(`错误日志:\n${stderr}`);
                    }
                    reject({
                        success: false,
                        message: error.message,
                        stderr,
                        stdout
                    });
                    return;
                }

                addLog(`✅ 执行成功`);
                if (stdout) {
                    const lines = stdout.split('\n').filter(l => l.trim());
                    lines.forEach(line => addLog(`OUTPUT: ${line}`));
                }

                resolve({
                    success: true,
                    outputPath,
                    message: `GWAS 分析完成，结果位于容器内 ${outputPath}`,
                    stdout
                });
            }
        );

        // 实时捕获输出
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
 * 发送邮件通知
 */
async function sendNotificationEmail(email, taskId, taskName, status, message, downloadUrl = '') {
    const mailOptions = {
        from: process.env.SMTP_FROM || 'noreply@gwas.local',
        to: email,
        subject: `GWAS 任务通知 - ${taskName} [${taskId}]`,
        html: `
            <h2>任务处理完成</h2>
            <p><strong>任务ID:</strong> ${taskId}</p>
            <p><strong>任务名称:</strong> ${taskName}</p>
            <p><strong>状态:</strong> <span style="color: ${status === 'success' ? 'green' : 'red'};">${status === 'success' ? '✅ 成功' : '❌ 失败'}</span></p>
            <p><strong>详情:</strong> ${message}</p>
            ${downloadUrl ? `<p><a href="${downloadUrl}" style="background: #667eea; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">📥 下载结果</a></p>` : ''}
            <hr>
            <p style="color: #999; font-size: 12px;">这是一封自动生成的邮件，请勿直接回复。</p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[邮件] 邮件已发送至: ${email}`);
        return { success: true, message: '邮件已发送' };
    } catch (error) {
        console.error(`[邮件] 发送失败: ${error.message}`);
        return { success: false, message: `邮件发送失败: ${error.message}` };
    }
}

async function processTask(taskId) {
    const task = tasks[taskId];
    if (!task) {
        return;
    }

    // 初始化日志
    if (!taskLogs[taskId]) {
        taskLogs[taskId] = [];
    }

    task.status = 'running';
    task.stage = 'copy';
    task.progress = 35;
    task.queuePosition = 0;
    task.startedAt = new Date();
    task.message = '任务开始执行，正在准备数据...';
    taskLogs[taskId].push(`[${new Date().toLocaleTimeString()}] ✅ 任务开始执行`);
    taskLogs[taskId].push(`[${new Date().toLocaleTimeString()}] 任务ID: ${taskId}`);

    try {
        await sleep(Math.max(500, Math.floor(PROCESSING_DELAY_MS / 2)));
        task.progress = 60;
        task.message = '正在将输入文件复制到共享数据卷...';

        const containerName = process.env.DOCKER_CONTAINER || 'gwas-worker';
        const copyResult = await executeCopyCommand(task.filePath, task.targetPath, containerName);

        task.stage = 'gwas';
        task.progress = 80;
        task.message = '正在执行 GWAS 分析脚本...';
        const runnerResult = await executeRunnerTask(containerName, copyResult.remoteFilePath, task.id);

        await sleep(Math.max(500, Math.floor(PROCESSING_DELAY_MS / 2)));
        task.status = 'completed';
        task.stage = 'done';
        task.progress = 100;
        task.processedRows = task.rowCount;
        task.completedAt = new Date();
        task.message = `✅ 已完成：GWAS 分析成功。结果位于 ${runnerResult.outputPath || runnerResult.outputDir}`;

        await sendNotificationEmail(
            task.email,
            task.id,
            task.taskName,
            'success',
            `GWAS 分析执行成功。处理 ${task.rowCount} 行数据。结果位于 ${runnerResult.outputPath}。`,
            `${BASE_URL}/api/download/${task.id}`
        );

        console.log(`[任务 ${task.id}] ✅ 完成`);
    } catch (error) {
        task.status = 'failed';
        task.stage = 'failed';
        task.progress = 100;
        task.completedAt = new Date();
        task.message = `❌ 任务失败: ${error.message || '未知错误'}`;

        await sendNotificationEmail(
            task.email,
            task.id,
            task.taskName,
            'failed',
            `任务处理失败：${error.message || '未知错误'}`
        );

        console.error(`[任务 ${task.id}] ❌ 失败:`, error);
    } finally {
        if (task.filePath && fs.existsSync(task.filePath)) {
            try {
                fs.unlinkSync(task.filePath);
                console.log(`[任务 ${task.id}] 临时文件已清理`);
            } catch (e) {
                console.error(`[任务 ${task.id}] 清理文件失败: ${e.message}`);
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
                console.error(`[任务 ${nextTaskId}] 处理异常:`, error);
            })
            .finally(() => {
                activeTaskCount = Math.max(0, activeTaskCount - 1);
                updateQueuedPositions();
                tryStartQueuedTasks();
            });
    }
}

/**
 * API 路由: 上传和处理
 */
app.post('/api/upload', async (req, res) => {
    try {
        const { email, targetPath, taskName, tableData, rowCount } = req.body;
        const taskId = uuidv4();

        // 验证输入
        if (!email || !targetPath || !tableData) {
            return res.status(400).json({
                success: false,
                message: '缺少必需的字段'
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

        // 保存任务信息
        tasks[taskId] = {
            id: taskId,
            email,
            targetPath: targetPathValidation.value,
            taskName: taskName || '未命名任务',
            status: 'queued',
            stage: 'queue',
            queuePosition: taskQueue.length + 1,
            createdAt: new Date(),
            rowCount: tableValidation.rowCount || rowCount || 0,
            processedRows: 0,
            progress: 0,
            message: `任务已接收，前方还有 ${taskQueue.length} 个任务`
        };

        // 生成临时文件
        const fileName = `table_${taskId}.csv`;
        const filePath = path.join(uploadsDir, fileName);
        
        fs.writeFileSync(filePath, tableData);
        tasks[taskId].filePath = filePath;
        console.log(`[任务 ${taskId}] 文件已保存: ${filePath}`);

        // 加入队列后触发调度
        taskQueue.push(taskId);
        updateQueuedPositions();
        tryStartQueuedTasks();

        // 立即返回响应
        res.json({
            success: true,
            taskId,
            status: tasks[taskId].status,
            queuePosition: tasks[taskId].queuePosition,
            activeTaskCount,
            queuedTaskCount: taskQueue.length,
            message: '任务已接收，进入队列处理中...'
        });

    } catch (error) {
        console.error(`[API] 错误: ${error.message}`);
        res.status(500).json({
            success: false,
            message: `服务器错误: ${error.message}`
        });
    }
});

/**
 * API 路由: 查询任务状态
 */
app.get('/api/status/:taskId', (req, res) => {
    const { taskId } = req.params;
    const task = tasks[taskId];

    if (!task) {
        return res.status(404).json({
            success: false,
            message: '任务不存在'
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
 * API 路由: 查询队列概览
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
 * API 路由: 下载结果（演示）
 */
app.get('/api/download/:taskId', (req, res) => {
    const { taskId } = req.params;
    const task = tasks[taskId];

    if (!task) {
        return res.status(404).json({
            success: false,
            message: '任务不存在'
        });
    }

    if (task.status !== 'completed') {
        return res.status(400).json({
            success: false,
            message: `任务未完成，当前状态: ${task.status}`
        });
    }

    // 生成结果文件（演示：简单的文本文件）
    const resultContent = `GWAS 处理结果\n=================================\n任务ID: ${taskId}\n任务名称: ${task.taskName}\n处理行数: ${task.processedRows}\n状态: ${task.status}\n完成时间: ${new Date().toLocaleString()}\n\n详情:\n${task.message}`;
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="result_${taskId}.txt"`);
    res.send(resultContent);
});

/**
 * API 路由: 查看任务日志
 */
app.get('/api/logs/:taskId', (req, res) => {
    const { taskId } = req.params;
    const task = tasks[taskId];

    if (!task) {
        return res.status(404).json({
            success: false,
            message: '任务不存在'
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
 * 健康检查
 */
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date() });
});

/**
 * 启动服务器
 */
app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`🚀 GWAS Web 服务已启动`);
    console.log(`📍 访问地址: http://localhost:${PORT}`);
    console.log(`📧 邮件服务: ${process.env.SMTP_HOST || '未配置'}`);
    console.log(`🐳 Docker 容器: ${process.env.DOCKER_CONTAINER || '未指定'}`);
    console.log(`🧬 Runner 镜像: ${GWAS_RUNNER_IMAGE}`);
    console.log(`⏱️  最大并发任务: ${MAX_CONCURRENT_TASKS}`);
    console.log(`🧪 演示延迟(替代GWAS): ${PROCESSING_DELAY_MS}ms`);
    console.log(`========================================\n`);
});

// 错误处理
process.on('unhandledRejection', (reason, promise) => {
    console.error('未处理的Promise拒绝:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('未捕获的异常:', error);
    process.exit(1);
});
