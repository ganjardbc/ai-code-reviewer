# Quick Start

This guide takes you from zero to a running AI Code Reviewer in the shortest possible path. It assumes you already have Node.js 22+, pnpm 9+, Redis 7+, and Git 2+ installed.

> For a more detailed explanation of each step, see [Installation](installation.md).

---

## Prerequisites Assumed

- Node.js 22+, pnpm 9+, Redis 7+, Git 2+
- A 9Router account with an API key
- A GitHub personal access token with `repo` scope
- A GitHub repository where you have admin access (to configure webhooks)

---

## 10 Steps to Your First AI Review

### 1. Clone and install

```bash
git clone https://github.com/your-org/ai-code-reviewer.git
cd ai-code-reviewer
pnpm install
```

### 2. Create your environment file

```bash
cp .env.example .env
```

### 3. Fill in required variables

Open `.env` and set at minimum:

```dotenv
OPENAI_API_KEY=<your-key>
OPENAI_BASE_URL=https://api.9router.com/v1
GITHUB_WEBHOOK_SECRET=<choose-any-random-string>
GITHUB_ACCESS_TOKEN=<your-github-pat>
```

Leave the GitLab variables empty if you are starting with GitHub only.

### 4. Start Redis

```bash
# Using Docker (easiest):
docker run -d --name redis -p 6379:6379 redis:7-alpine

# Or, if Redis is installed locally:
redis-server
```

### 5. Build TypeScript

```bash
pnpm build
```

### 6. Start the API server

```bash
node dist/presentation/web/server.js
```

Leave this terminal open. The server listens on port 3000.

### 7. Start the worker (new terminal)

```bash
node dist/worker.js
```

Leave this terminal open too.

### 8. Confirm everything is up

```bash
curl -s http://localhost:3000/health
```

Expected:

```json
{"status":"healthy","timestamp":"...","services":{"redis":"up","disk":"up"}}
```

### 9. Expose the service to the internet

GitHub webhooks require a publicly reachable URL. For local development use `ngrok` or a similar tunnel:

```bash
ngrok http 3000
```

Note the HTTPS forwarding URL — you will need it in the next step. Example: `https://abc123.ngrok-free.app`

### 10. Register the webhook in GitHub

1. Go to your repository on GitHub.
2. Navigate to **Settings → Webhooks → Add webhook**.
3. Set **Payload URL** to `https://abc123.ngrok-free.app/webhooks/github`.
4. Set **Content type** to `application/json`.
5. Set **Secret** to the same value as `GITHUB_WEBHOOK_SECRET` in your `.env`.
6. Under **Which events**, select **Let me select individual events** → tick **Pull requests**.
7. Click **Add webhook**.

---

## Verify: Open a Pull Request

Open (or reopen) a pull request in the repository. Within a few seconds you should see:

- In the API server terminal: `POST /webhooks/github 202` log line
- In the worker terminal: job processing logs, then a "comments posted" line
- In the GitHub PR: inline AI review comments on changed files

If comments do not appear within 30 seconds, see [First Review — Troubleshooting](first-review.md#troubleshooting).

---

## Next Steps

- Read [First Review](first-review.md) for a full walkthrough with log interpretation.
- See [Architecture Overview](architecture-overview.md) to understand how the service works internally.
- Review [Installation](installation.md) for all environment variables and production deployment options.
