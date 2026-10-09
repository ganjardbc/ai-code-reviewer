# Local Development

Full setup guide for contributing to or customizing the AI Code Reviewer.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 22.x | Use nvm/fnm to pin version |
| pnpm | 9.x | `npm install -g pnpm` |
| Docker | 24.x | For Redis |
| ngrok | Latest | For webhook testing |
| Git | 2.x | |

---

## Initial Setup

```bash
# Clone the repo
git clone https://github.com/your-org/ai-code-reviewer.git
cd ai-code-reviewer

# Install dependencies
pnpm install

# Copy environment config
cp .env.example .env
```

Edit `.env` and fill in at minimum:

```dotenv
NODE_ENV=development
LOG_LEVEL=debug
REDIS_URL=redis://localhost:6379
OPENAI_API_KEY=your_key_here
OPENAI_BASE_URL=https://api.9router.io
GITHUB_WEBHOOK_SECRET=local-dev-secret
GITHUB_ACCESS_TOKEN=ghp_your_token
WORKSPACE_DIR=/tmp/ai-reviewer/workspace
```

---

## Starting Redis

```bash
docker run -d \
  --name ai-reviewer-redis \
  -p 6379:6379 \
  redis:7-alpine

# Verify
docker exec ai-reviewer-redis redis-cli ping   # → PONG
```

---

## Running in Development Mode (Hot Reload)

Two processes, two terminals:

### Terminal 1 — API Server

```bash
pnpm dev
```

Uses `tsx` to run `src/presentation/web/server.ts` directly with automatic restart on file changes. Logs are pretty-printed via `pino-pretty`.

### Terminal 2 — Worker

```bash
pnpm dev:worker
```

Uses `tsx` to run `src/worker.ts` with automatic restart on file changes.

---

## Running Tests

### All Tests

```bash
pnpm test
```

Uses Vitest. Tests run in watch mode by default in development.

### Single Run (CI Mode)

```bash
pnpm test --run
```

### With Coverage

```bash
pnpm test:coverage
```

Opens an HTML coverage report in `coverage/`. Coverage thresholds are defined in `vitest.config.ts`.

### Run Specific Test File

```bash
pnpm test src/application/use-cases/process-review.use-case.test.ts
```

### Run Specific Test by Name

```bash
pnpm test --reporter=verbose -t "should post inline comments"
```

---

## Type Checking

TypeScript type checking without emitting JavaScript:

```bash
pnpm typecheck
```

This runs `tsc --noEmit` against the full project. Fix all type errors before submitting a PR.

---

## Linting

```bash
pnpm lint
```

Uses ESLint with `typescript-eslint`. Auto-fix safe issues:

```bash
pnpm lint --fix
```

---

## Building

Compile TypeScript to `dist/`:

```bash
pnpm build
```

The compiled output mirrors the `src/` structure under `dist/`. This is what runs in production.

---

## Debug Logging

Set `LOG_LEVEL=debug` in `.env` to see detailed logs including:

- Full webhook payloads received
- Prompt sent to the AI provider
- Raw AI response
- File filtering decisions
- Queue events

```dotenv
LOG_LEVEL=debug
```

> **Warning:** Debug logs may contain sensitive data (code from your repos, tokens in headers). Use only in local development.

---

## ngrok Webhook Testing

ngrok creates a public HTTPS tunnel to your local development server, allowing real webhooks from GitHub/GitLab to reach `localhost:3000`.

### Install ngrok

```bash
# macOS
brew install ngrok

# Linux
snap install ngrok
# or download from https://ngrok.com/download
```

### Create an Account and Authenticate

```bash
ngrok config add-authtoken <your_ngrok_authtoken>
```

### Start the Tunnel

```bash
# Make sure pnpm dev is running first
ngrok http 3000
```

ngrok output:

```
Forwarding  https://abc123.ngrok-free.app -> http://localhost:3000
```

### Configure GitHub Webhook

1. Go to your test repo → **Settings** → **Webhooks** → **Add webhook**
2. Payload URL: `https://abc123.ngrok-free.app/webhooks/github`
3. Content type: `application/json`
4. Secret: same value as `GITHUB_WEBHOOK_SECRET` in `.env`
5. Events: **Pull requests**

### Open a Test PR

Push a branch and open a PR on your test repository. Within 30 seconds you should see:

1. A POST request in the ngrok web UI (`http://localhost:4040`)
2. Log output in the API server terminal (`202 Accepted`)
3. The worker picking up the job
4. A review comment appearing on the PR

### ngrok Web UI

ngrok provides a local web UI at `http://localhost:4040` where you can:
- View all incoming requests and their full payloads
- Replay requests (useful for retesting the same webhook)
- Inspect response bodies

---

## Useful Development Shortcuts

```bash
# Watch TypeScript errors in real time
pnpm typecheck -- --watch

# Run only unit tests (fast)
pnpm test src/domain
pnpm test src/application

# Check what a webhook payload looks like
cat tests/fixtures/github-pr-opened.json | jq .

# Manually trigger the health endpoint
curl http://localhost:3000/health | jq .

# Inspect Redis queue state
docker exec ai-reviewer-redis redis-cli LLEN "bull:review-queue:wait"
```
