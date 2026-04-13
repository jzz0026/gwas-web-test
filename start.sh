#!/bin/bash

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function: print header
print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

# Function: print success message
print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

# Function: print error message
print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Function: print warning message
print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

# Function: print info message
print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

# Main program
main() {
    print_header "GWAS Web System Initialization"

    # Check Docker and Docker Compose
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed"
        exit 1
    fi
    print_success "Docker is installed"

    if ! command -v docker-compose &> /dev/null; then
        print_warning "docker-compose not found, trying docker compose"
        COMPOSE_CMD="docker compose"
        if ! docker compose version &> /dev/null; then
            print_error "Docker Compose is not available"
            exit 1
        fi
    else
        COMPOSE_CMD="docker-compose"
    fi
    print_success "Docker Compose is available"

    # Check Node.js (for local development)
    if command -v node &> /dev/null; then
        print_success "Node.js is installed ($(node --version))"
    else
        print_warning "Node.js is not installed"
    fi

    # Create .env file if needed
    if [ ! -f ".env" ]; then
        print_info "Creating .env file..."
        if [ -f ".env.example" ]; then
            cp .env.example .env
            print_success ".env file created (edit it as needed)"
        else
            print_error ".env.example file does not exist"
            exit 1
        fi
    else
        print_success ".env file already exists"
    fi

    # Choose startup mode
    echo ""
    print_header "Choose startup mode"
    echo "1) Start with Docker Compose (recommended, includes mail service)"
    echo "2) Start for local development (requires Node.js)"
    echo "3) Start only Docker worker container"
    echo ""
    read -p "Please choose [1-3]: " choice

    case $choice in
        1)
            print_header "Docker Compose startup"
            print_info "Building images and starting services..."
            $COMPOSE_CMD down
            $COMPOSE_CMD up -d gwas-web mailserver gwas-worker

            # Keep worker created but stopped; it will be started when a task runs.
            $COMPOSE_CMD stop gwas-worker
            
            # Wait for services to start
            sleep 3
            
            # Check service status
            echo ""
            print_header "Service status"
            $COMPOSE_CMD ps
            
            echo ""
            print_success "Web and mail services are up. Worker is standby (stopped)."
            echo ""
            print_info "📍 Web app: ${GREEN}http://localhost:3000${NC}"
            print_info "📧 MailHog: ${GREEN}http://localhost:8025${NC}"
            print_info "🧬 Worker mode: starts on task submission, stops after task completion"
            print_info "📋 View logs: ${YELLOW}docker-compose logs -f gwas-web${NC}"
            print_info "Stop services: ${YELLOW}docker-compose down${NC}"
            ;;
        2)
            print_header "Local development startup"
            if ! command -v node &> /dev/null; then
                print_error "Node.js is not installed, cannot start locally"
                exit 1
            fi
            
            print_info "Installing dependencies..."
            npm install
            
            print_info "Starting service..."
            npm start
            ;;
        3)
            print_header "Start Docker worker container"
            $COMPOSE_CMD up -d gwas-worker mailserver
            print_success "Containers started"
            $COMPOSE_CMD ps
            ;;
        *)
            print_error "Invalid selection"
            exit 1
            ;;
    esac
}

# Run main program
main
