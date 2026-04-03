#!/bin/bash

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 函数：打印标题
print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

# 函数：打印成功信息
print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

# 函数：打印错误信息
print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# 函数：打印警告信息
print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

# 函数：打印信息
print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

# 主程序
main() {
    print_header "GWAS Web 系统初始化"

    # 检查 Docker 和 Docker Compose
    if ! command -v docker &> /dev/null; then
        print_error "Docker 未安装"
        exit 1
    fi
    print_success "Docker 已安装"

    if ! command -v docker-compose &> /dev/null; then
        print_warning "Docker Compose 未安装，尝试使用 docker compose"
        COMPOSE_CMD="docker compose"
        if ! docker compose version &> /dev/null; then
            print_error "Docker Compose 不可用"
            exit 1
        fi
    else
        COMPOSE_CMD="docker-compose"
    fi
    print_success "Docker Compose 可用"

    # 检查 Node.js（用于本地开发）
    if command -v node &> /dev/null; then
        print_success "Node.js 已安装 ($(node --version))"
    else
        print_warning "Node.js 未安装"
    fi

    # 复制 .env 文件
    if [ ! -f ".env" ]; then
        print_info "创建 .env 文件..."
        if [ -f ".env.example" ]; then
            cp .env.example .env
            print_success ".env 文件已创建（请根据需要编辑）"
        else
            print_error ".env.example 文件不存在"
            exit 1
        fi
    else
        print_success ".env 文件已存在"
    fi

    # 选择启动方式
    echo ""
    print_header "选择启动方式"
    echo "1) Docker Compose 启动（推荐，包含邮件服务）"
    echo "2) 本地开发启动（需要 Node.js）"
    echo "3) 仅启动 Docker 工作容器"
    echo ""
    read -p "请选择 [1-3]: " choice

    case $choice in
        1)
            print_header "Docker Compose 启动"
            print_info "构建镜像并启动服务..."
            $COMPOSE_CMD down
            $COMPOSE_CMD up -d
            
            # 等待服务启动
            sleep 3
            
            # 检查服务状态
            echo ""
            print_header "服务状态"
            $COMPOSE_CMD ps
            
            echo ""
            print_success "所有服务已启动！"
            echo ""
            print_info "📍 访问 Web 应用: ${GREEN}http://localhost:3000${NC}"
            print_info "📧 访问 MailHog: ${GREEN}http://localhost:8025${NC}"
            print_info "📋 查看日志: ${YELLOW}docker-compose logs -f gwas-web${NC}"
            print_info "停止服务: ${YELLOW}docker-compose down${NC}"
            ;;
        2)
            print_header "本地开发启动"
            if ! command -v node &> /dev/null; then
                print_error "Node.js 未安装，无法本地启动"
                exit 1
            fi
            
            print_info "安装依赖..."
            npm install
            
            print_info "启动服务..."
            npm start
            ;;
        3)
            print_header "启动 Docker 工作容器"
            $COMPOSE_CMD up -d gwas-worker mailserver
            print_success "容器已启动"
            $COMPOSE_CMD ps
            ;;
        *)
            print_error "无效的选择"
            exit 1
            ;;
    esac
}

# 运行主程序
main
