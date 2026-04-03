# GWAS Web 数据上传系统

一个功能完整的网页应用，用于上传两列表格数据到 Docker 环境进行处理。该系统支持文件上传、数据处理、邮件通知和结果下载等功能。

## 功能特性

✨ **核心功能**
- 📤 支持 CSV 文件上传或手动输入表格数据
- 🐳 自动推送数据到 Docker 容器（使用 `docker cp` 命令）
- 📧 任务完成后自动发送邮件通知
- 📥 提供结果文件下载功能
- 🔍 实时任务状态查询
- 🎨 现代化的响应式网页界面

## 系统架构

```
┌─────────────────────┐
│   前端网页 (HTML)    │
│  - 文件上传         │
│  - 表格输入         │
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│  Express 服务器     │
│  - 接收上传         │
│  - Docker CP        │
│  - 邮件发送         │
└──────────┬──────────┘
           │
    ┌──────┴──────┐
    │             │
┌───▼────┐   ┌───▼──────┐
│ Docker │   │ 邮件服务 │
│容器    │   │ (SMTP)  │
└────────┘   └─────────┘
```

## 快速开始

### 前置条件

- Docker & Docker Compose
- Node.js 14+ (本地开发)
- 现代浏览器

### 使用 Docker Compose 启动（推荐）

```bash
# 1. 复制环境配置文件
cp .env.example .env

# 编辑 .env 文件配置邮件服务（可选）
# SMTP_USER=your-email@gmail.com
# SMTP_PASS=your-password
# SMTP_FROM=noreply@gwas.local

# 2. 构建并启动所有服务
docker-compose up -d

# 3. 查看日志
docker-compose logs -f gwas-web

# 4. 访问应用
# 网页: http://localhost:3000
# 邮件测试: http://localhost:8025 (MailHog)
```

### 本地开发（不使用 Docker）

```bash
# 1. 复制环境配置
cp .env.example .env

# 2. 安装依赖
npm install

# 3. 启动服务器
npm start

# 4. 访问应用
# http://localhost:3000
```

### 使用 Docker 容器启动

```bash
# 构建镜像
docker build -t gwas-web:latest .

# 运行容器
docker run -p 3000:3000 \
  -e DOCKER_CONTAINER=gwas-worker \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/uploads:/app/uploads \
  gwas-web:latest
```

## 配置说明

### 环境变量 (.env)

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务器端口 | 3000 |
| `DOCKER_CONTAINER` | 目标 Docker 容器名 | gwas-worker |
| `SMTP_HOST` | SMTP 服务器地址 | localhost |
| `SMTP_PORT` | SMTP 端口 | 587 |
| `SMTP_SECURE` | 是否使用 SSL | false |
| `SMTP_USER` | SMTP 用户名 | 空 |
| `SMTP_PASS` | SMTP 密码 | 空 |
| `SMTP_FROM` | 发件人邮箱 | noreply@gwas.local |

### Docker Compose 服务

- **gwas-web**: Node.js 应用服务 (端口 3000)
- **gwas-worker**: Ubuntu 处理容器 (接收文件)
- **mailserver**: MailHog 邮件服务 (SMTP: 1025, Web: 8025)

## API 端点

### 上传表格数据

**请求:**
```
POST /api/upload
Content-Type: application/json

{
  "email": "user@example.com",
  "targetPath": "/data/input/",
  "taskName": "我的任务",
  "tableData": "column1\tcolumn2\ndata1\tdata2\ndata3\tdata4",
  "rowCount": 2
}
```

**响应:**
```json
{
  "success": true,
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "message": "任务已接收，正在处理中..."
}
```

### 查询任务状态

**请求:**
```
GET /api/status/{taskId}
```

**响应:**
```json
{
  "success": true,
  "task": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "completed",
    "taskName": "我的任务",
    "rowCount": 2,
    "processedRows": 2,
    "message": "✅ 成功复制 2 行数据到 /data/input/",
    "createdAt": "2024-04-03T10:30:00.000Z"
  }
}
```

### 下载结果

**请求:**
```
GET /api/download/{taskId}
```

**响应:** 返回结果文件 (text/plain)

### 健康检查

**请求:**
```
GET /health
```

**响应:**
```json
{
  "status": "ok",
  "timestamp": "2024-04-03T10:30:00.000Z"
}
```

## 表格数据格式

### CSV 文件格式

```csv
column1,column2
data1,data2
data3,data4
```

或使用制表符分隔：

```
column1	column2
data1	data2
data3	data4
```

### 手动输入格式

支持以下两种分隔符：
- 制表符 (Tab)
- 逗号 (,)

示例：
```
Name	Age
Alice	25
Bob	30
```

## 工作流程

1. **用户输入**
   - 输入接收邮箱
   - 上传 CSV 文件或手动输入表格
   - 指定 Docker 容器目标路径
   - 提交表单

2. **后端处理**
   - 接收表格数据
   - 生成临时文件
   - 异步执行 `docker cp` 命令
   - 更新任务状态

3. **邮件通知**
   - 任务完成后发送邮件
   - 包含下载链接
   - 错误情况下发送失败通知

4. **结果下载**
   - 用户可通过邮件链接下载结果
   - 或通过 `/api/download/{taskId}` 端点下载

## 邮件配置示例

### 使用 Gmail

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=your-email@gmail.com
```

> 注: Gmail 需要使用 [App Password](https://myaccount.google.com/apppasswords)

### 使用公司邮件服务器

```env
SMTP_HOST=mail.company.com
SMTP_PORT=587
SMTP_SECURE=true
SMTP_USER=username
SMTP_PASS=password
SMTP_FROM=noreply@company.com
```

### 本地测试 (MailHog)

使用 Docker Compose 已预置了 MailHog，无需额外配置。访问 http://localhost:8025 查看邮件。

## 常见问题

### Q: 如何修改 Docker 容器名称？
A: 编辑 `.env` 文件，修改 `DOCKER_CONTAINER` 变量，或在 `docker-compose.yml` 中修改 `container_name`。

### Q: Docker copy 失败怎么办？
A: 
- 检查目标容器是否正在运行: `docker ps`
- 检查目标路径是否存在于容器中
- 查看查看服务器日志: `docker-compose logs gwas-web`

### Q: 为什么没有收到邮件？
A:
- 检查 SMTP 配置是否正确
- 对于 Gmail，确保使用了 App Password
- 在 MailHog 中检查邮件: http://localhost:8025

### Q: 上传的文件在哪里？
A: 文件保存在 `./uploads` 目录中，处理完成后会自动删除。

## 文件结构

```
gwas-web-test/
├── public/
│   └── index.html              # 前端页面
├── server.js                   # Express 服务器
├── package.json                # Node.js 依赖
├── Dockerfile                  # Docker 镜像配置
├── docker-compose.yml          # Docker Compose 配置
├── .env.example                # 环境变量示例
├── .gitignore                  # Git 忽略文件
└── README.md                   # 本文件
```

## 部署建议

### 生产环境

1. **使用真实的 SMTP 服务器**（Gmail、SendGrid 等）
2. **配置 HTTPS**（使用 Nginx 反向代理）
3. **使用数据库存储任务信息**（替代内存存储）
4. **添加认证机制**（防止滥用）
5. **设置请求限流**（保护 API）
6. **配置文件清理策略**（自动删除旧文件）
7. **添加错误日志和监控**

### 推荐架构

```
┌──────────────────┐
│   HTTPS Reverse  │
│   Proxy (Nginx)  │
└────────┬─────────┘
         │
┌────────▼─────────┐
│   Load Balancer  │
└────────┬─────────┘
    ┌────┴────┐
    │          │
┌───▼──┐  ┌───▼──┐
│gwas1 │  │gwas2 │  (多实例)
└───┬──┘  └───┬──┘
    │         │
    └────┬────┘
  ┌─────▼──────┐
  │  Database  │  (存储任务状态)
  └────────────┘
```

## 许可证

MIT

## 支持和联系

如有问题或建议，请提交 Issue 或 PR。