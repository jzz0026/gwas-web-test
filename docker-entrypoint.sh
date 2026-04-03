#!/bin/bash

# GWAS Web 服务启动脚本

echo "=========================================="
echo "🚀 GWAS Web 服务启动"
echo "=========================================="

# 检查环境变量
echo "📋 环境配置:"
echo "  - PORT: ${PORT:-3000}"
echo "  - Docker 容器: ${DOCKER_CONTAINER:-gwas-worker}"
echo "  - SMTP 主机: ${SMTP_HOST:-未配置}"

# 检查 Docker 连接
if [ -S /var/run/docker.sock ]; then
    echo "✅ Docker Socket 连接正常"
else
    echo "⚠️  警告: Docker Socket 不可用，docker cp 功能可能无法使用"
fi

# 启动 Node.js 应用
echo "启动 Node.js 应用..."
exec npm start
