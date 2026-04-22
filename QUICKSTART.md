# GWAS Web Quick Start

## Start in 3 Minutes

### Requirements

- Docker and Docker Compose installed
- At least 2 GB free memory

## Startup Options

### Option 1: One-command startup (recommended)

```bash
cd gwas-web-test
bash start.sh
# Choose option 1 in the menu
```

Note: option 1 keeps `gwas-worker` in standby (stopped). It starts automatically when a task is submitted.

### Option 2: Manual Docker Compose startup

```bash
cd gwas-web-test
docker-compose up -d
```

### Option 3: Local development startup

```bash
cd gwas-web-test
npm install
npm start
```

## Open the Application

| Service | URL | Purpose |
|---|---|---|
| Web App | http://localhost:3000 | Main UI |
| MailHog | http://localhost:8025 | Email testing inbox |

## Quick Test Flow

### 1) Upload a table

1. Open http://localhost:3000
2. Enter your email address
3. Choose upload mode:
4. `Upload CSV/TSV File` for a two-column file, or
5. `Enter Data Manually` for direct paste
6. Click `Submit Task`

### 2) Track progress

- A task ID is returned immediately
- Processing runs asynchronously in queue
- Status and logs update in the UI

### 3) Check email notification

Open http://localhost:8025 to view outgoing email in MailHog.

## Sample Data

### CSV format

```csv
gene_name,expression_level
GENE001,2.5
GENE002,3.8
GENE003,1.2
```

### Tab-separated format

```text
gene_name	expression_level
GENE001	2.5
GENE002	3.8
GENE003	1.2
```

## Useful Commands

```bash
# Container status
docker-compose ps

# App logs
docker-compose logs -f gwas-web

# Stop all services
docker-compose down

# Restart app
docker-compose restart gwas-web

# Start worker (needed before exec if worker is in standby)
docker-compose start gwas-worker

# Enter worker container
docker-compose exec gwas-worker sh

# List uploaded files in worker container
docker-compose exec gwas-worker ls -la /data/input/
```

## Common Config Changes

Edit `.env`:

```env
PORT=3000
DOCKER_CONTAINER=gwas-worker
SMTP_HOST=mailserver
SMTP_PORT=1025
```

## FAQ

### How do I change SMTP settings?

Edit SMTP values in `.env` and restart the app:

```bash
docker-compose restart gwas-web
```

### How do I inspect uploaded data?

```bash
docker-compose start gwas-worker
docker-compose exec gwas-worker ls -la /data/input/
```

### What if email is not sent?

Check MailHog at http://localhost:8025 and review logs:

```bash
docker-compose logs gwas-web | grep -i mail
```

### What if Docker copy fails?

Check `DOCKER_CONTAINER` in `.env`, then verify the container is running:

```bash
docker-compose ps
```

### How do I deploy this in production?

See [DEPLOYMENT.md](./DEPLOYMENT.md).

## More Resources

- Full docs: [README.md](./README.md)
- Deployment guide: [DEPLOYMENT.md](./DEPLOYMENT.md)
- API test script: `bash test-api.sh`

## Need Help?

1. Check logs: `docker-compose logs`
2. Run API test: `bash test-api.sh`
3. Review FAQ in docs

Start now:

```bash
bash start.sh
```
