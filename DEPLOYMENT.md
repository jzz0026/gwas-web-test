# GWAS Web 系统 - 部署指南

## 快速开始

### 1️⃣ 使用 Docker Compose（推荐）

最简单的方式，包含所有必要的服务。

```bash
# 进入项目目录
cd gwas-web-test

# 复制环境配置
cp .env.example .env

# 启动所有服务
docker-compose up -d

# 查看日志
docker-compose logs -f gwas-web
```

**访问地址：**
- 🌐 Web 应用: http://localhost:3000
- 📧 MailHog (邮件测试): http://localhost:8025
- 🐳 Docker 容器:
  - `gwas-web` - Node.js 应用
  - `gwas-worker` - 处理容器
  - `gwas-mailserver` - 邮件服务

### 2️⃣ 本地开发

适合开发人员，直接运行 Node.js。

**前置要求：**
- Node.js 14+
- npm 或 yarn
- Docker（用于 docker cp 命令）

```bash
# 安装依赖
npm install

# 创建 .env 文件
cp .env.example .env

# 启动服务
npm start

# 开发模式（带热重载）
npm run dev  # 需要安装 nodemon
```

### 3️⃣ 仅运行 Docker 工作容器

如果你想在自己的环境中运行应用。

```bash
# 启动工作容器和邮件服务
docker-compose up -d gwas-worker mailserver

# 本地运行应用
npm install
npm start
```

## 环境配置

### .env 配置说明

```env
# 服务器端口
PORT=3000

# Docker 配置（重要！）
# 指定接收文件的容器名称
DOCKER_CONTAINER=gwas-worker

# SMTP 邮件配置
SMTP_HOST=mailserver          # Docker Compose 环境下使用 'mailserver'
SMTP_PORT=1025                # MailHog 端口
SMTP_SECURE=false
SMTP_USER=                    # 可不填（MailHog 不需要认证）
SMTP_PASS=                    # 可不填
SMTP_FROM=noreply@gwas.local  # 发件人地址
```

### 常见邮件配置

**MailHog（本地测试）**
```env
SMTP_HOST=mailserver
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
```

**Gmail**
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password  # 使用应用密码，非账户密码
```

**SendGrid**
```env
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=apikey
SMTP_PASS=SG.xxxxx
```

**阿里云企业邮箱**
```env
SMTP_HOST=smtp.mxhichina.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@company.com
SMTP_PASS=your-password
```

## Docker Compose 服务说明

### gwas-web (Node.js 应用)
- **镜像**: 本地构建
- **端口**: 3000
- **依赖**: gwas-worker, mailserver
- **挂载**:
  - `./uploads` - 上传文件临时存储
  - `/var/run/docker.sock` - Docker 访问

### gwas-worker (处理容器)
- **镜像**: 本地构建 (`Dockerfile.gwas-worker`)
- **目的**: 接收和存储数据文件
- **依赖安装方式**: apt 直装（不使用 conda）
- **内置依赖**: Python 2.7、R、MASS、MatrixCalc、mvnpermute、wget、unzip、libgfortran3
- **数据卷**:
  - `gwas-data-input` - 输入数据
  - `gwas-data-output` - 输出数据

> 说明：`mvnpermute` 已固化在镜像构建阶段，容器重建后依然可用。

### gwas-mailserver (MailHog)
- **镜像**: `mailhog/mailhog`
- **SMTP 端口**: 1025
- **Web UI**: http://localhost:8025

## 常见操作命令

```bash
# 查看所有容器状态
docker-compose ps

# 查看服务日志
docker-compose logs gwas-web       # 应用日志
docker-compose logs gwas-worker    # 工作容器日志
docker-compose logs -f             # 实时日志

# 进入容器
docker-compose exec gwas-web sh    # 进入应用容器
docker-compose exec gwas-worker sh # 进入工作容器

# 查看容器内文件
docker-compose exec gwas-worker ls -la /data/input/

# 停止服务
docker-compose stop

# 重启服务
docker-compose restart gwas-web

# 删除所有容器（保留数据）
docker-compose down

# 删除所有内容（包括数据卷）
docker-compose down -v

# 重新构建镜像
docker-compose build --no-cache
```

## 处理常见问题

### ❌ Docker CP 失败

**症状**: 任务状态为"failed"

**排查步骤**:
```bash
# 1. 检查目标容器是否运行
docker-compose ps gwas-worker

# 2. 查看错误日志
docker-compose logs gwas-web | grep -i docker

# 3. 容器没运行时，检查启动错误
docker-compose logs gwas-worker

# 4. 测试 docker cp 命令
docker cp /path/to/file gwas-worker:/data/input/
```

### ❌ 邮件发送失败

**症状**: 完成后未收到邮件

**排查步骤**:
```bash
# 1. 检查 SMTP 配置
cat .env | grep SMTP

# 2. 查看邮件日志
docker-compose logs gwas-web | grep -i mail

# 3. 访问 MailHog Web UI
# http://localhost:8025 查看邮件队列

# 4. 重启邮件服务
docker-compose restart gwas-mailserver
```

### ❌ 端口被占用

**症状**: 端口 3000、1025 或 8025 已被使用

**解决方案**:
```bash
# 方案 1: 修改 docker-compose.yml 中的端口映射
# 例如: "3001:3000" 使用本地 3001 端口

# 方案 2: 杀死占用端口的进程
lsof -i :3000  # 查找占用 3000 端口的进程
kill -9 <PID>  # 杀死进程
```

### ❌ 权限错误 (Permission denied)

**症状**: Docker socket 访问错误

**解决方案**:
```bash
# 方案 1: 使用 sudo
sudo docker-compose up -d

# 方案 2: 加入 docker group
sudo usermod -aG docker $USER
# 需要重新登录或 newgrp docker
```

## 生产环境部署

### 前置检查清单

- [ ] 使用真实的 SMTP 服务器
- [ ] 配置 HTTPS（使用反向代理）
- [ ] 设置数据库存储任务状态
- [ ] 配置认证和授权
- [ ] 部署监控和日志系统
- [ ] 定期备份数据卷
- [ ] 设置自动清理策略

### Docker Swarm 部署

```bash
# 初始化 Swarm
docker swarm init

# 部署服务
docker stack deploy -c docker-compose.yml gwas

# 查看服务
docker service ls

# 查看服务日志
docker service logs gwas_gwas-web
```

### Kubernetes 部署

参考 [k8s 部署指南](./k8s-deployment.yaml)（如果存在）

### 云平台部署

**AWS ECS:**
```bash
# 构建并推送镜像到 ECR
aws ecr get-login-password | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com
docker tag gwas-web:latest <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/gwas-web:latest
docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/gwas-web:latest
```

**阿里云容器服务:**
```bash
# 推送到阿里云
docker tag gwas-web:latest registry.cn-beijing.aliyuncs.com/your-namespace/gwas-web:latest
docker push registry.cn-beijing.aliyuncs.com/your-namespace/gwas-web:latest
```

## 监控和维护

### 系统监控
```bash
# 查看容器资源使用情况
docker stats gwas-web

# 查看磁盘使用
docker system df
```

### 日志管理
```bash
# 导出日志
docker-compose logs gwas-web > logs.txt

# 清理日志
docker system prune

# 限制日志大小（在 docker-compose.yml 中添加）
# - max-size: "10m"
# - max-file: "3"
```

### 数据备份
```bash
# 备份数据卷
docker run --rm -v gwas-data-input:/data \
  -v $(pwd)/backups:/backup \
  ubuntu tar czf /backup/data-input-backup.tar.gz -C /data .

# 恢复数据卷
docker run --rm -v gwas-data-input:/data \
  -v $(pwd)/backups:/backup \
  ubuntu tar xzf /backup/data-input-backup.tar.gz -C /data
```

## 获取帮助

1. 查看日志: `docker-compose logs`
2. 测试 API: `./test-api.sh`
3. 访问应用: `http://localhost:3000`
4. 查看 README.md 获取更多信息

---

**最后更新**: 2024-04-03
