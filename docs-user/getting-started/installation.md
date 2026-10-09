# Installation

This guide walks through a complete installation from source. By the end you will have the API server and worker running locally with a verified health check.

> Before starting, confirm you meet all [Requirements](requirements.md).

---

## Step 1 — Clone the Repository

```bash
git clone https://github.com/your-org/ai-code-reviewer.git
cd ai-code-reviewer
```

---

## Step 2 — Install Dependencies

```bash
pnpm install
```

This installs all production and development dependencies declared in `package.json` using the lockfile (`pnpm-lock.yaml`) to guarantee reproducible versions.

---

## Step 3 — Create the Environment File

```bash
cp .env.example .env
```

Open `.env` in your editor. The file looks like this:

```dotenv
# Server
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

# Redis (required)
REDIS_URL=redis://localhost:6379

# 9Router AI Gateway (required)
OPENAI_API_KEY=your-9router-api-key-here
OPENAI_BASE_URL=https://api.9router.com/v1

# GitHub Integration (required)
GITHUB_WEBHOOK_SECRET=your-github-webhook-secret
GITHUB_ACCESS_TOKEN=your-github-personal-access-token

# GitLab Integration (required)
GITLAB_WEBHOOK_SECRET=your-gitlab-webhook-secret
GITLAB_ACCESS_TOKEN=your-gitlab-personal-access-token

# Worker
WORKSPACE_DIR=/tmp/ai-reviewer/workspace
QUEUE_JOB_TTL_SECONDS=86400
QUEUE_MAX_JOBS_RETAINED=100
```

Fill in every value marked `your-*`. See the [Environment Variable Reference](#environment-variable-reference) table below for a description of each variable.

---

## Step 4 — Start Redis

If you have Redis installed locally, start it:

```bash
redis-server
```

Or use Docker:

```bash
docker compose up -d redis
```

Verify Redis is accessible:

```bash
redis-cli ping
# PONG
```

If your `REDIS_URL` uses a non-default host or port, update it in `.env`.

---

## Step 5 — Build TypeScript

```bash
pnpm build
```

This runs `tsc` and outputs compiled JavaScript to `dist/`. The build must complete without errors before you can run the service.

To watch for changes during development:

```bash
pnpm dev
```

---

## Step 6 — Start the API Server

```bash
node dist/presentation/web/server.js
```

You should see log output similar to:

```
{"level":"info","time":"...","msg":"Server listening on http://0.0.0.0:3000"}
{"level":"info","time":"...","msg":"Redis connected"}
```

---

## Step 7 — Start the Worker

Open a second terminal (or use a process manager such as `pm2`):

```bash
node dist/worker.js
```

Expected output:

```
{"level":"info","time":"...","msg":"Worker started, waiting for jobs"}
{"level":"info","time":"...","msg":"Redis connected"}
```

---

## Step 8 — Verify the Health Endpoint

```bash
curl -s http://localhost:3000/health | jq .
```

Expected response:

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "services": {
    "redis": "up",
    "disk": "up"
  }
}
```

If `redis` shows `"down"`, the API server cannot reach Redis. Check `REDIS_URL` in `.env` and confirm Redis is running.

---

## Running Both Processes Together (Development)

For convenience during development you can run both processes in a single terminal using a tool such as `concurrently`:

```bash
npx concurrently \
  "node dist/presentation/web/server.js" \
  "node dist/worker.js"
```

---

## Production: Docker Compose

For production deployments, use the bundled Docker Compose configuration:

```bash
# Build the image
docker compose build

# Start all services (Redis, API server, worker)
docker compose up -d

# Follow logs
docker compose logs -f
```

The `Dockerfile` uses a three-stage build (builder → pruner → runner) with a non-root user (`appuser`) on Alpine Linux. The final image contains only production dependencies.

---

## Environment Variable Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP port the API server listens on |
| `NODE_ENV` | No | `development` | Set to `production` in deployed environments |
| `LOG_LEVEL` | No | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `REDIS_URL` | Yes | — | Full Redis connection string, e.g., `redis://localhost:6379` |
| `OPENAI_API_KEY` | Yes | — | API key for the 9Router AI gateway |
| `OPENAI_BASE_URL` | Yes | — | Base URL for the 9Router API, e.g., `https://api.9router.com/v1` |
| `GITHUB_WEBHOOK_SECRET` | Yes* | — | Secret used to validate GitHub webhook HMAC signatures |
| `GITHUB_ACCESS_TOKEN` | Yes* | — | GitHub personal access token (`repo` scope) |
| `GITLAB_WEBHOOK_SECRET` | Yes* | — | Secret used to validate GitLab webhook tokens |
| `GITLAB_ACCESS_TOKEN` | Yes* | — | GitLab personal access token (`api` scope) |
| `WORKSPACE_DIR` | No | `/tmp/ai-reviewer/workspace` | Base directory for temporary job workspaces |
| `QUEUE_JOB_TTL_SECONDS` | No | `86400` | How long completed job records are retained in Redis (seconds) |
| `QUEUE_MAX_JOBS_RETAINED` | No | `100` | Maximum number of completed jobs to keep in the queue history |

\* Required for the corresponding platform; omit if you are not integrating with that platform.
