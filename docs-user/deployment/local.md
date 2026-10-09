# Local Development Setup

This guide walks you through running the AI Code Reviewer on your local machine without Docker. Use this for development and testing.

---

## Prerequisites

| Tool | Minimum Version | Check |
|------|----------------|-------|
| Node.js | 22.x | `node --version` |
| pnpm | 9.x | `pnpm --version` |
| Docker (for Redis) | 24.x | `docker --version` |
| Git | 2.x | `git --version` |

> **Tip:** Use [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm) to manage Node.js versions. A `.nvmrc` file at the project root pins the correct version.

---

## 1. Clone the Repository

```bash
git clone https://github.com/your-org/ai-code-reviewer.git
cd ai-code-reviewer
```

---

## 2. Install Dependencies

```bash
pnpm install
```

This installs all runtime and development dependencies from `pnpm-lock.yaml`. The lockfile is committed — do not delete it.

---

## 3. Configure Environment Variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

Open `.env` and configure the required variables:

```dotenv
# Server
PORT=3000
NODE_ENV=development
LOG_LEVEL=debug

# Redis (local Docker instance)
REDIS_URL=redis://localhost:6379

# AI Provider (9Router)
OPENAI_API_KEY=your_nine_router_api_key_here
OPENAI_BASE_URL=https://api.9router.io

# GitHub (optional — only if testing GitHub webhooks)
GITHUB_WEBHOOK_SECRET=your_local_test_secret
GITHUB_ACCESS_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

# GitLab (optional — only if testing GitLab webhooks)
GITLAB_WEBHOOK_SECRET=your_local_test_secret
GITLAB_ACCESS_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx

# Workspace
WORKSPACE_DIR=/tmp/ai-reviewer/workspace

# Queue
QUEUE_JOB_TTL_SECONDS=86400
QUEUE_MAX_JOBS_RETAINED=100
WORKER_CONCURRENCY=3
```

> **Warning:** Never commit your `.env` file. It is listed in `.gitignore`.

---

## 4. Start Redis

Start a Redis instance via Docker (no persistent data needed for local dev):

```bash
docker run -d \
  --name ai-reviewer-redis \
  -p 6379:6379 \
  redis:7-alpine
```

Verify Redis is running:

```bash
docker exec ai-reviewer-redis redis-cli ping
# Expected output: PONG
```

To stop Redis later:

```bash
docker stop ai-reviewer-redis && docker rm ai-reviewer-redis
```

---

## 5. Build the Project

```bash
pnpm build
```

TypeScript compiles to `dist/`. This is required before running the production-mode commands (`pnpm start`, `pnpm start:worker`).

---

## 6. Run the API Server and Worker

You need **two separate terminal sessions** — the API server and the worker are independent processes.

### Terminal 1 — API Server (hot reload)

```bash
pnpm dev
```

The server starts on `http://localhost:3000` with `tsx` watching for file changes.

### Terminal 2 — Worker (hot reload)

```bash
pnpm dev:worker
```

The worker connects to Redis and begins polling the BullMQ queue for review jobs.

> **Tip:** Both processes must be running for end-to-end webhook processing. The API server enqueues jobs; the worker processes them.

---

## 7. Verify the Setup

### Health Check

```bash
curl -s http://localhost:3000/health | jq .
```

Expected response (healthy):

```json
{
  "status": "healthy",
  "redis": "connected"
}
```

If Redis is down, the response will be:

```json
{
  "status": "unhealthy",
  "redis": "disconnected"
}
```
with HTTP status `503`.

### Send a Test Webhook (GitHub)

```bash
curl -s -X POST http://localhost:3000/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: ping" \
  -H "X-Hub-Signature-256: sha256=<computed_hmac>" \
  -d '{"zen": "test"}'
```

> For real webhook testing with HMAC signatures, see [Testing Webhooks Locally (ngrok)](../development/local-development.md#ngrok-webhook-testing).

---

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `ECONNREFUSED 127.0.0.1:6379` | Redis not running | Start Redis with `docker run` (step 4) |
| `Cannot find module 'dist/...'` | Project not built | Run `pnpm build` |
| Worker exits immediately | `REDIS_URL` incorrect | Check `.env`, verify `redis-cli ping` |
| `OPENAI_API_KEY` error | Missing env var | Add key to `.env` |

---

## Useful Development Commands

```bash
pnpm lint          # Run ESLint
pnpm typecheck     # Run TypeScript type checking (no emit)
pnpm test          # Run all tests with Vitest
pnpm test:coverage # Run tests with coverage report
```
