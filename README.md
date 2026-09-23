# AI Code Reviewer

Self-hosted AI code reviewer that integrates with GitHub and GitLab. Posts inline review comments on PRs/MRs automatically via webhooks or on-demand via `/review` comments, and can auto-apply fixes for those comments via `/fix`.

## How it works

Two independent Node.js processes communicate through a BullMQ queue backed by Redis:

```
Webhook (GitHub / GitLab)
  → Fastify server  (signature verification, payload parsing)
  → Redis queue     (BullMQ job)
  → Worker process  (clones repo, generates diff, calls AI, posts review)
```

Trigger modes:
- **PR/MR open/reopen/sync** — reviews automatically on lifecycle events (enabled by default)
- **`/review` comment** — post `/review` in any PR/MR comment to trigger a review on demand (enabled by default)
- **`/fix` comment** — post `/fix` in any PR/MR comment to fetch outstanding AI review comments, apply fixes, and push a commit directly to the PR/MR branch (disabled by default — see `ENABLE_FIX_BY_COMMENT`)

## Requirements

- Node.js ≥ 22
- Redis
- GitHub and/or GitLab access tokens + webhook secrets
- An AI backend (9Router API key **or** `opencode` CLI installed)

## Setup

```bash
cp .env.example .env
# Fill in the required values (see Configuration below)

pnpm install
```

## Running

Two processes must run simultaneously:

```bash
pnpm dev          # Fastify web server (port 3000)
pnpm dev:worker   # BullMQ worker
```

Or with Docker Compose:

```bash
docker compose up
```

> **Note**: To also attach `api`/`worker` to the external `devbox_devnet` network (e.g. for Nginx Proxy Manager), add the overlay: `docker compose -f docker-compose.yml -f docker-compose.devbox.yml up`. `deploy.sh` does this automatically when that network exists.

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `REDIS_URL` | Yes | Redis connection URL (e.g. `redis://localhost:6379`) |
| `GITHUB_WEBHOOK_SECRET` | Yes* | Secret set when registering the GitHub webhook |
| `GITHUB_ACCESS_TOKEN` | Yes* | GitHub PAT with repo read + PR write permissions |
| `GITLAB_WEBHOOK_SECRET` | Yes* | Secret set when registering the GitLab webhook |
| `GITLAB_ACCESS_TOKEN` | Yes* | GitLab PAT with api scope |
| `AI_RUNNER` | No | `direct` (default) or `opencode` |
| `NINE_ROUTER_API_KEY` | When `AI_RUNNER=direct` | API key for 9Router AI gateway |
| `NINE_ROUTER_BASE_URL` | No | Default: `https://api.9router.com/v1` |
| `NINE_ROUTER_MODEL` | No | Model to use via 9Router |
| `OPENCODE_COMMAND` | When `AI_RUNNER=opencode` | CLI binary name (default: `opencode`) |
| `ENABLE_REVIEW_BY_COMMENT` | No | `true`/`false` — enable `/review` comment trigger (default: `true`) |
| `ENABLE_REVIEW_BY_MR_OPEN` | No | `true`/`false` — enable PR/MR open trigger (default: `true`) |
| `ENABLE_FIX_BY_COMMENT` | No | `true`/`false` — enable `/fix` comment trigger (default: `false`) |
| `WORKSPACE_DIR` | No | Where repos are cloned (default: `/tmp/ai-reviewer/workspace`) |
| `PORT` | No | Server port (default: `3000`) |

*At least one platform (GitHub or GitLab) must be configured.

> **Note**: `/fix` pushes commits directly to the PR/MR branch, so `GITHUB_ACCESS_TOKEN`/`GITLAB_ACCESS_TOKEN` need write (not just read) access to the repository when `ENABLE_FIX_BY_COMMENT=true`.

## Webhook setup

### GitHub

1. Go to **Settings → Webhooks → Add webhook** in your repo or org
2. Payload URL: `https://your-host/webhooks/github`
3. Content type: `application/json`
4. Secret: value of `GITHUB_WEBHOOK_SECRET`
5. Events: **Pull requests** + **Issue comments**

### GitLab

1. Go to **Settings → Webhooks** in your project
2. URL: `https://your-host/webhooks/gitlab`
3. Secret token: value of `GITLAB_WEBHOOK_SECRET`
4. Triggers: **Merge request events** + **Comments**

## AI Backends

### `direct` (default)

Routes requests through the [9Router](https://9router.com) AI gateway. Requires `NINE_ROUTER_API_KEY`.

### `opencode`

Spawns the [`opencode`](https://opencode.ai) CLI locally. Install it first:

```bash
npm install -g opencode-ai
```

Set `AI_RUNNER=opencode` in your `.env`. The Docker image doesn't include the CLI by default — build the worker with `INSTALL_OPENCODE=true` (e.g. `INSTALL_OPENCODE=true docker compose build worker`). The worker exits at startup if the CLI can't be run.

## Production build

```bash
pnpm build      # Compiles TypeScript → dist/
pnpm start      # node dist/presentation/web/server.js
pnpm start:worker
```

## Development

```bash
pnpm typecheck  # Type check (strict)
pnpm lint       # ESLint
pnpm test       # Run all tests
pnpm test:watch # Watch mode
```

Integration tests mock Redis — no real Redis needed for tests.

## Project structure

```
src/
  config/               Config loading and Zod schema validation
  domain/               Interfaces and error types (no dependencies)
  application/          Use cases and services (prompt, parser)
  infrastructure/       Git, AI runners, queue, VCS clients, logging
  presentation/         Fastify app, routes, DTOs
  worker.ts             Worker process entrypoint
```

## License

MIT
