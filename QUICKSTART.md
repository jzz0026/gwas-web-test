# 🚀 GWAS Web 快速开始指南

## ⚡ 3 分钟快速启动

### 前置要求
- ✅ Docker & Docker Compose 已安装
- ✅ 至少 2GB 可用内存

### 启动步骤

#### 方式 1：一键启动（推荐）

```bash
# 进入项目目录
cd gwas-web-test

# 运行启动脚本
bash start.sh

# 选择第 1 项：Docker Compose 启动
```

#### 方式 2：手动 Docker Compose 启动

```bash
cd gwas-web-test
docker-compose up -d
```

#### 方式 3：本地开发启动

```bash
cd gwas-web-test
npm install
npm start
```

## 🌐 访问应用

启动完成后，打开浏览器访问：

| 应用 | 地址 | 说明 |
|------|------|------|
| 🌐 Web 应用 | http://localhost:3000 | 主要应用界面 |
| 📧 MailHog | http://localhost:8025 | 邮件测试工具 |

## 📤 快速测试

### 1. 上传表格

1. 打开 http://localhost:3000
2. 输入邮箱地址
3. 选择上传方式：
   - **上传 CSV 文件**: 上传包含两列的 CSV 文件
   - **手动输入**: 直接输入表格数据
4. 指定目标路径（默认: `/data/input/`）
5. 点击 **提交任务**

### 2. 查看处理进度

- 任务提交后立即返回任务 ID
- 系统异步处理数据
- 完成后发送邮件通知

### 3. 查看邮件

访问 http://localhost:8025 查看发送的邮件

## 📝 示例数据

### CSV 格式
```csv
gene_name,expression_level
GENE001,2.5
GENE002,3.8
GENE003,1.2
```

### 手动输入格式
```
gene_name	expression_level
GENE001	2.5
GENE002	3.8
GENE003	1.2
```

## 📋 常用命令

```bash
# 查看所有容器状态
docker-compose ps

# 查看应用日志
docker-compose logs -f gwas-web

# 停止服务
docker-compose down

# 重启应用
docker-compose restart gwas-web

# 进入工作容器
docker-compose exec gwas-worker bash

# 查看上传到容器的文件
docker-compose exec gwas-worker ls -la /data/input/
```

## 🔧 配置修改

编辑 `.env` 文件可修改以下配置：

```env
PORT=3000                      # 应用端口
DOCKER_CONTAINER=gwas-worker   # 目标容器名
SMTP_HOST=mailserver           # 邮件服务器
SMTP_PORT=1025                 # 邮件端口
```

## ❓ 常见问题

**Q: 如何修改邮件配置？**
A: 编辑 `.env` 文件中的 SMTP 配置，然后重启应用: `docker-compose restart gwas-web`

**Q: 如何查看上传的数据？**
A: 运行 `docker-compose exec gwas-worker ls -la /data/input/`

**Q: 邮件没有发出怎么办？**
A: 访问 http://localhost:8025 查看 MailHog，或检查日志: `docker-compose logs gwas-web | grep -i mail`

**Q: Docker CP 失败？**
A: 检查 `.env` 中的 `DOCKER_CONTAINER` 是否正确，运行 `docker-compose ps` 确认容器在运行

**Q: 如何在生产环境上使用？**
A: 参考 [DEPLOYMENT.md](./DEPLOYMENT.md) 获取详细指南

## 📚 更多信息

- 📖 完整文档: [README.md](./README.md)
- 🚀 部署指南: [DEPLOYMENT.md](./DEPLOYMENT.md)
- 🧪 API 测试: `bash test-api.sh`

## 🆘 获取帮助

1. 查看日志: `docker-compose logs`
2. 测试 API: `bash test-api.sh`
3. 查看文档中的常见问题

---

**开始使用：** `bash start.sh` ✨
