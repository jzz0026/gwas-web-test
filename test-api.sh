#!/bin/bash

# GWAS Web API test script

BASE_URL="http://localhost:3000"

echo "=========================================="
echo "GWAS Web API test tool"
echo "=========================================="
echo ""

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Test health check
echo "📍 Test 1: Health check"
echo "Request: GET /health"
response=$(curl -s -X GET "$BASE_URL/health")
echo "Response: $response"
echo ""

# Test table upload
echo "📍 Test 2: Upload table data"
echo "Request: POST /api/upload"

# Prepare test data
read -p "Enter test email [test@example.com]: " email
email=${email:-test@example.com}

read -p "Enter target path in Docker container [/data/input/]: " target_path
target_path=${target_path:-/data/input/}

# Create sample table data
table_data="Name	Age
Alice	25
Bob	30
Charlie	35"

echo "Sending request..."
response=$(curl -s -X POST "$BASE_URL/api/upload" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"$email\",
    \"targetPath\": \"$target_path\",
  \"taskName\": \"Test Task\",
    \"tableData\": \"$table_data\",
    \"rowCount\": 3
  }")

echo "Response: $response"
echo ""

# Extract taskId
task_id=$(echo "$response" | grep -o '"taskId":"[^"]*' | cut -d'"' -f4)

if [ ! -z "$task_id" ]; then
  echo -e "${GREEN}✅ Task created: $task_id${NC}"
    echo ""
    
  # Test status query
  echo "📍 Test 3: Query task status"
    sleep 2
  echo "Request: GET /api/status/$task_id"
    status_response=$(curl -s -X GET "$BASE_URL/api/status/$task_id")
  echo "Response: $status_response"
    echo ""
    
  # Test result download
  echo "📍 Test 4: Download result"
  echo "Request: GET /api/download/$task_id"
  echo "Downloading file..."
    curl -s -X GET "$BASE_URL/api/download/$task_id" -o "result_${task_id}.txt"
    
    if [ -f "result_${task_id}.txt" ]; then
    echo -e "${GREEN}✅ File downloaded: result_${task_id}.txt${NC}"
        echo ""
    echo "File content:"
        cat "result_${task_id}.txt"
    else
    echo -e "${RED}❌ File download failed${NC}"
    fi
else
  echo -e "${RED}❌ Failed to create task${NC}"
fi

echo ""
echo "=========================================="
echo "Test completed"
echo "=========================================="
