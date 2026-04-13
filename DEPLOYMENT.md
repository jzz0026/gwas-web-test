# GWAS Web Deployment Guide

## Quick Start

### 1) Docker Compose (recommended)

The easiest option with all required services included.

```bash
cd gwas-web-test
cp .env.example .env
docker-compose up -d
docker-compose logs -f gwas-web
```

Access:

- Web app: http://localhost:3000
- MailHog: http://localhost:8025
- Containers:
- `gwas-web` (Node.js app)
- `gwas-worker` (processing worker)
- `gwas-mailserver` (mail service)

### 2) Local development

Best for active backend/frontend development.

Requirements:

- Node.js 14+
- npm or yarn
- Docker (for `docker cp` and worker runtime)

```bash
npm install
cp .env.example .env
npm start

# Optional hot reload (if nodemon is installed)
npm run dev
```

### 3) Start worker-only services

Run worker and mail service in Docker, app locally:

```bash
docker-compose up -d gwas-worker mailserver
npm install
npm start
```

## Environment Configuration

### `.env` reference

```env
# Server
PORT=3000

# Docker (important)
DOCKER_CONTAINER=gwas-worker

# SMTP
SMTP_HOST=mailserver
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=noreply@gwas.local
```

### Common SMTP setups

MailHog (local test):

```env
SMTP_HOST=mailserver
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
```

Gmail:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
```

SendGrid:

```env
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=apikey
SMTP_PASS=SG.xxxxx
```

Aliyun enterprise mailbox:

```env
SMTP_HOST=smtp.mxhichina.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@company.com
SMTP_PASS=your-password
```

## Docker Compose Services

### `gwas-web` (Node.js app)

- Image: built locally
- Port: `3000`
- Depends on: `gwas-worker`, `mailserver`
- Mounts:
- `./uploads` (temporary uploaded files)
- `/var/run/docker.sock` (Docker access)

### `gwas-worker` (processing container)

- Image: built from `Dockerfile.gwas-worker`
- Purpose: receives and processes uploaded data
- Dependency install strategy: apt packages (no conda)
- Built-in dependencies include: Python 2.7, R, MASS, MatrixCalc, mvnpermute, wget, unzip, libgfortran3
- Volumes:
- `gwas-data-input` for inputs
- `gwas-data-output` for outputs

`mvnpermute` is installed during image build and remains available after container recreation.

### `gwas-mailserver` (MailHog)

- Image: `mailhog/mailhog`
- SMTP port: `1025`
- UI: http://localhost:8025

## Common Operations

```bash
# Container status
docker-compose ps

# Logs
docker-compose logs gwas-web
docker-compose logs gwas-worker
docker-compose logs -f

# Enter containers
docker-compose exec gwas-web sh
docker-compose exec gwas-worker sh

# List files in worker input path
docker-compose exec gwas-worker ls -la /data/input/

# Stop services
docker-compose stop

# Restart app
docker-compose restart gwas-web

# Remove containers (keep volumes)
docker-compose down

# Remove containers and volumes
docker-compose down -v

# Rebuild images without cache
docker-compose build --no-cache
```

## Troubleshooting

### Docker copy fails

Symptom: task status becomes `failed`.

```bash
# 1) Verify worker container is running
docker-compose ps gwas-worker

# 2) Check app logs
docker-compose logs gwas-web | grep -i docker

# 3) If worker failed to start, inspect worker logs
docker-compose logs gwas-worker

# 4) Test docker cp directly
docker cp /path/to/file gwas-worker:/data/input/
```

### Email sending fails

Symptom: no email after completion.

```bash
# 1) Verify SMTP config
cat .env | grep SMTP

# 2) Check mail-related logs
docker-compose logs gwas-web | grep -i mail

# 3) Check MailHog inbox
# http://localhost:8025

# 4) Restart mail service
docker-compose restart gwas-mailserver
```

### Port conflict

Symptom: ports `3000`, `1025`, or `8025` are already in use.

```bash
# Option 1: change port mappings in docker-compose.yml
# Example: "3001:3000"

# Option 2: stop the process that holds the port
lsof -i :3000
kill -9 <PID>
```

### Permission denied (Docker socket)

```bash
# Option 1: run with sudo
sudo docker-compose up -d

# Option 2: add current user to docker group
sudo usermod -aG docker $USER
# then re-login or run: newgrp docker
```

## Production Deployment Checklist

- [ ] Use a real SMTP provider
- [ ] Enable HTTPS with a reverse proxy
- [ ] Persist task states in a database
- [ ] Add authentication and authorization
- [ ] Add centralized monitoring and logging
- [ ] Back up data volumes regularly
- [ ] Add automated cleanup policies

## Swarm Deployment

```bash
docker swarm init
docker stack deploy -c docker-compose.yml gwas
docker service ls
docker service logs gwas_gwas-web
```

## Kubernetes Deployment

See `k8s-deployment.yaml` if present in the repository.

## Cloud Deployment

AWS ECS (ECR):

```bash
aws ecr get-login-password | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com
docker tag gwas-web:latest <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/gwas-web:latest
docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/gwas-web:latest
```

Aliyun container service:

```bash
docker tag gwas-web:latest registry.cn-beijing.aliyuncs.com/your-namespace/gwas-web:latest
docker push registry.cn-beijing.aliyuncs.com/your-namespace/gwas-web:latest
```

## Monitoring and Maintenance

### System monitoring

```bash
docker stats gwas-web
docker system df
```

### Log management

```bash
# Export logs
docker-compose logs gwas-web > logs.txt

# Clean unused resources
docker system prune

# Optional log limits in docker-compose.yml
# - max-size: "10m"
# - max-file: "3"
```

### Volume backup and restore

```bash
# Backup
docker run --rm -v gwas-data-input:/data \
  -v $(pwd)/backups:/backup \
  ubuntu tar czf /backup/data-input-backup.tar.gz -C /data .

# Restore
docker run --rm -v gwas-data-input:/data \
  -v $(pwd)/backups:/backup \
  ubuntu tar xzf /backup/data-input-backup.tar.gz -C /data
```

## Getting Help

1. Check logs: `docker-compose logs`
2. Run API test: `./test-api.sh`
3. Open app: `http://localhost:3000`
4. Read additional details in `README.md`

---

Last updated: 2026-04-13
