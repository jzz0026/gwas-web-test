# GWAS Web Data Upload System

A complete web application for uploading two-column table data to a Docker environment for processing. The system supports file upload, asynchronous task processing, email notifications, and result download.

## Features

- CSV file upload or manual table input
- Automatic file copy into Docker container via `docker cp`
- Email notification when a task completes or fails
- Downloadable task result file
- Real-time task status polling
- Responsive browser UI

## Architecture

```text
┌─────────────────────┐
│ Frontend (HTML/JS)  │
│ - File upload       │
│ - Manual input      │
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│ Express Server      │
│ - Accepts requests  │
│ - Docker copy/run   │
│ - Sends emails      │
└──────────┬──────────┘
           │
    ┌──────┴──────┐
    │             │
┌───▼────┐   ┌───▼──────┐
│ Docker │   │ SMTP     │
│ Worker │   │ Service  │
└────────┘   └──────────┘
```

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Node.js 18+ (for local development)
- A modern browser

### Start with Docker Compose (recommended)

```bash
# 1) Copy environment template
cp .env.example .env

# Optional: configure SMTP in .env
# SMTP_USER=your-email@gmail.com
# SMTP_PASS=your-app-password
# SMTP_FROM=noreply@gwas.local

# 2) Build and start services
docker-compose up -d

# 3) Follow logs
docker-compose logs -f gwas-web

# 4) Open the app
# Web app:  http://localhost:3000
# MailHog:  http://localhost:8025
```

### Local Development (without Docker app container)

```bash
cp .env.example .env
npm install
npm start
```

### Build and run app image manually

```bash
docker build -t gwas-web:latest .

docker run -p 3000:3000 \
  -e DOCKER_CONTAINER=gwas-worker \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/uploads:/app/uploads \
  gwas-web:latest
```

## Configuration

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `3000` |
| `DOCKER_CONTAINER` | Target Docker container name | `gwas-worker` |
| `SMTP_HOST` | SMTP host | `localhost` |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_SECURE` | Use TLS/SSL | `false` |
| `SMTP_USER` | SMTP username | empty |
| `SMTP_PASS` | SMTP password | empty |
| `SMTP_FROM` | Sender address | `noreply@gwas.local` |
| `MAX_CONCURRENT_TASKS` | Max tasks running in parallel | `2` |
| `PROCESSING_DELAY_MS` | Demo delay (ms) | `3000` |
| `BASE_URL` | Public base URL in emails | `http://localhost:3000` |
| `GWAS_RUNNER_IMAGE` | Runner image tag | `gwas-worker:latest` |

### Docker Compose services

- `gwas-web`: Node.js API + frontend (`3000`)
- `gwas-worker`: processing container and shared volumes
- `mailserver`: MailHog SMTP (`1025`) + UI (`8025`)

## API Endpoints

### Upload table data

Request:

```http
POST /api/upload
Content-Type: application/json
```

```json
{
  "email": "user@example.com",
  "targetPath": "/data/input/",
  "taskName": "My Task",
  "selectedGrain": "ecoli1",
  "tableData": "column1\tcolumn2\ndata1\tdata2\ndata3\tdata4",
  "rowCount": 2
}
```

Required fields: `email`, `targetPath`, `tableData`, `selectedGrain`.
`rowCount` is optional metadata.

Typical response:

```json
{
  "success": true,
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Task received and queued for processing..."
}
```

### Query task status

```http
GET /api/status/{taskId}
```

The status payload includes queue position, progress/stage, and archive metadata such as `archiveReady`, `archiveExpiresAt`, and `archiveRetentionDays`.

### Query queue overview

```http
GET /api/queue
```

### Download result

```http
GET /api/download/{taskId}
```

### Query task logs

```http
GET /api/logs/{taskId}
```

### List and download example phenotype files

```http
GET /api/examples
GET /api/examples/{grain}/pheno
GET /api/examples/{grain}/download
```

### Health check

```http
GET /health
```

## Table Format

Use exactly two columns per non-empty line.

When uploading, `selectedGrain` must be one of the configured examples (currently `ecoli1` or `ecoli2`).
The first column values are validated against the selected example phenotype file.

CSV example:

```csv
column1,column2
data1,data2
data3,data4
```

Tab-separated example:

```text
column1	column2
data1	data2
data3	data4
```

## Workflow

1. User submits email + table data.
2. Server validates and stores a temporary input file.
3. Task enters queue and is processed asynchronously.
4. Input file is copied into worker container.
5. GWAS script is executed in container.
6. User gets completion/failure email and can download results.

## SMTP Examples

### Gmail

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=your-email@gmail.com
```

### Company SMTP

```env
SMTP_HOST=mail.company.com
SMTP_PORT=587
SMTP_SECURE=true
SMTP_USER=username
SMTP_PASS=password
SMTP_FROM=noreply@company.com
```

### Local test with MailHog

MailHog is preconfigured in Docker Compose. Open http://localhost:8025.

## FAQ

### How do I change the Docker container name?

Set `DOCKER_CONTAINER` in `.env`, or update `container_name` in `docker-compose.yml`.

### What if docker copy fails?

- Verify target container is running: `docker ps`
- Verify target path exists in the container
- Check app logs: `docker-compose logs gwas-web`

### Why did I not receive any email?

- Verify SMTP configuration
- For Gmail, use an app password
- Check MailHog inbox at http://localhost:8025

### Where are uploaded files stored?

Temporary input files are written under `./uploads` and removed after processing.
Result archives are also written under `./uploads` and retained for 7 days by default, then cleaned automatically.

## Project Structure

```text
gwas-web-test/
├── public/
│   └── index.html
├── server.js
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

## Production Notes

1. Use a real SMTP provider (Gmail/SendGrid/etc).
2. Add HTTPS through a reverse proxy (Nginx/Caddy).
3. Replace in-memory task storage with a database.
4. Add authentication and request rate limits.
5. Add log retention and monitoring.
6. Add periodic cleanup and backups for volumes.
7. Externalize task state to durable storage (current queue/task data is in-memory).

## License

MIT

## Support

Open an issue or pull request for bugs, suggestions, or improvements.
