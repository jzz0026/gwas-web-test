#!/bin/bash

# GWAS Web API 测试脚本

BASE_URL="http://localhost:3000"

echo "=========================================="
echo "GWAS Web API 测试工具"
echo "=========================================="
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 测试健康检查
echo "📍 测试 1: 健康检查"
echo "请求: GET /health"
response=$(curl -s -X GET "$BASE_URL/health")
echo "响应: $response"
echo ""

# 测试上传表格
echo "📍 测试 2: 上传表格数据"
echo "请求: POST /api/upload"

# 准备测试数据
read -p "请输入测试邮箱 [test@example.com]: " email
email=${email:-test@example.com}

read -p "请输入 Docker 容器目标路径 [/data/input/]: " target_path
target_path=${target_path:-/data/input/}

# 创建测试表格数据
table_data="Name	Age
Alice	25
Bob	30
Charlie	35"

echo "发送请求..."
response=$(curl -s -X POST "$BASE_URL/api/upload" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"$email\",
    \"targetPath\": \"$target_path\",
    \"taskName\": \"测试任务\",
    \"tableData\": \"$table_data\",
    \"rowCount\": 3
  }")

echo "响应: $response"
echo ""

# 提取 taskId
task_id=$(echo "$response" | grep -o '"taskId":"[^"]*' | cut -d'"' -f4)

if [ ! -z "$task_id" ]; then
    echo -e "${GREEN}✅ 任务已创建: $task_id${NC}"
    echo ""
    
    # 测试查询状态
    echo "📍 测试 3: 查询任务状态"
    sleep 2
    echo "请求: GET /api/status/$task_id"
    status_response=$(curl -s -X GET "$BASE_URL/api/status/$task_id")
    echo "响应: $status_response"
    echo ""
    
    # 测试下载结果
    echo "📍 测试 4: 下载结果"
    echo "请求: GET /api/download/$task_id"
    echo "下载文件..."
    curl -s -X GET "$BASE_URL/api/download/$task_id" -o "result_${task_id}.txt"
    
    if [ -f "result_${task_id}.txt" ]; then
        echo -e "${GREEN}✅ 文件已下载: result_${task_id}.txt${NC}"
        echo ""
        echo "文件内容:"
        cat "result_${task_id}.txt"
    else
        echo -e "${RED}❌ 文件下载失败${NC}"
    fi
else
    echo -e "${RED}❌ 任务创建失败${NC}"
fi

echo ""
echo "=========================================="
echo "测试完成"
echo "=========================================="
