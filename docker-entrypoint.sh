#!/bin/bash

# GWAS Web service startup script

echo "=========================================="
echo "🚀 GWAS Web service starting"
echo "=========================================="

# Check environment variables
echo "📋 Environment configuration:"
echo "  - PORT: ${PORT:-3000}"
echo "  - Docker container: ${DOCKER_CONTAINER:-gwas-worker}"
echo "  - SMTP host: ${SMTP_HOST:-not configured}"

# Check Docker connection
if [ -S /var/run/docker.sock ]; then
    echo "✅ Docker socket is available"
else
    echo "⚠️  Warning: Docker socket is unavailable, docker cp may not work"
fi

# Start Node.js app
echo "Starting Node.js application..."
exec npm start
