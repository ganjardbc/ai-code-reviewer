# AI Code Reviewer

Self-hosted AI code reviewer that integrates with GitHub and GitLab. Posts inline review comments on PRs/MRs automatically via webhooks or on-demand via `/review` comments, and can auto-apply fixes for those comments via `/fix`.

## How it works

Two independent Node.js processes communicate through a BullMQ queue backed by Redis:

```
Webhook (GitHub / GitLab)
  → Fastify server  (signature verification, payload parsing, permission check)
  → Redis queue     (BullMQ job)
  → Worker process  (clones repo, generates diff, calls AI, posts review)
```

Trigger modes:
- **PR/MR open/reopen/sync** — reviews automatically on lifecycle events (enabled by default)
- **`/review` comment** — post `/review` in any PR/MR comment to trigger a review on demand (enabled by default)
- **`/fix` comment** — post `/fix` in any PR/MR comment to fetch outstanding AI review comments, apply fixes, and push a commit directly to the PR/MR branch (disabled by default — see `ENABLE_FIX_BY_COMMENT`)

Comment commands must start the comment (`/review ...`, `/fix ...`), only work on open PRs/MRs, and are only honored from users with push rights: GitHub collaborators with `write` or `admin` permission, GitLab members with Developer access or higher. Comments from anyone else are ignored.

## What gets reviewed

The AI only sees the PR/MR diff — never the whole repository:

- **Diff range**: `git diff origin/<base>...HEAD`, i.e. the changes on the PR/MR branch since it diverged from the base branch. Unchanged files and code outside the diff hunks are not sent.
- **Ignored files**: lock files (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `composer.lock`, `Gemfile.lock`, `Cargo.lock`), minified assets and source maps (`*.min.js`, `*.min.css`, `*.map`), build output (`dist/`, `build/`, `.next/`, `out/`), and binaries (images, fonts, `pdf`, `zip`, `gz`, `tar`).
- **Context**: each change keeps at most 3 surrounding context lines.
- **Size cap**: 40 KB of diff after filtering. Files are added in diff order; once the next file would exceed the cap, it and every file after it are left out, and the AI is told the diff was truncated. Keep PRs small for full coverage.

The review looks for security vulnerabilities, memory/resource leaks, performance problems, race conditions, logic and error-handling bugs, and maintainability issues. Purely stylistic preferences (tabs vs spaces, quote style, formatting) are deliberately not commented on. Each comment carries a severity (`INFO`, `WARNING`, `CRITICAL`); all severities are posted, none are filtered.

Fork PRs/MRs are reviewed too: the worker fetches the platform's head ref from the base repository, so it needs no access to the fork.

## How `/fix` works

1. Collects the outstanding review comments this bot posted on the PR/MR. Threads already marked resolved are skipped.
2. Clones the PR/MR branch and sends the full current content of each affected file, plus its issues, to the AI.
3. Writes the corrected files back, commits, and pushes directly to the PR/MR head branch, then posts a summary comment.

Safeguards: fixes for files that had no outstanding comment are dropped, a truncated AI response is rejected rather than written as a partial file, and if the branch moved during the run the fix commit is rebased onto it once before the push is retried.

## Requirements

- Node.js ≥ 22 and pnpm
- Redis
- `git` on the worker host
- GitHub and GitLab access tokens + webhook secrets (see the note under [Configuration](#configuration) if you use only one platform)
- An AI backend (an OpenAI-compatible API key **or** `opencode` CLI installed)

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

Or with Docker Compose, which starts Redis, the API and the worker:

```bash
docker compose up
```

Compose overrides `REDIS_URL`, `WORKSPACE_DIR`, `NODE_ENV` and (for the worker) `WORKER_CONCURRENCY=3` regardless of `.env`.

> **Note**: To also attach `api`/`worker` to the external `devbox_devnet` network (e.g. for Nginx Proxy Manager), add the overlay: `docker compose -f docker-compose.yml -f docker-compose.devbox.yml up`. `deploy.sh` does this automatically when that network exists.

### `deploy.sh`

Wrapper around Docker Compose for server deployments:

```bash
./deploy.sh        # Restart api + worker (no rebuild)
./deploy.sh -b     # Rebuild images, then deploy
./deploy.sh -f     # Incremental rebuild + rolling restart
./deploy.sh -c     # Only check the health of the current deployment
./deploy.sh -h     # All options
```

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /webhooks/github` | GitHub webhook receiver |
| `POST /webhooks/gitlab` | GitLab webhook receiver |
| `GET /health` | Checks Redis connectivity and write access to `WORKSPACE_DIR`. `200 { status: "healthy" }` or `503` with per-service detail |

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `REDIS_URL` | Yes | Redis connection URL (e.g. `redis://localhost:6379`) |
| `GITHUB_WEBHOOK_SECRET` | Yes | Secret set when registering the GitHub webhook |
| `GITHUB_ACCESS_TOKEN` | Yes | GitHub PAT with repo read + PR write permissions |
| `GITLAB_WEBHOOK_SECRET` | Yes | Secret set when registering the GitLab webhook |
| `GITLAB_ACCESS_TOKEN` | Yes | GitLab PAT with `api` scope |
| `GITLAB_API_URL` | No | Base URL of a self-managed GitLab instance |
| `AI_RUNNER` | No | `direct` (default) or `opencode` |
| `OPENAI_API_KEY` | When `AI_RUNNER=direct` | API key for the OpenAI-compatible endpoint |
| `OPENAI_BASE_URL` | When `AI_RUNNER=direct` | Base URL of the endpoint, e.g. `https://api.openai.com/v1`. No default |
| `OPENAI_MODEL` | No | Model name sent to the endpoint. Default: `gpt-4o-mini` |
| `OPENCODE_COMMAND` | No | `opencode` CLI binary name (default: `opencode`) |
| `OPENCODE_TIMEOUT_MS` | No | Timeout for one `opencode` run (default: `120000`) |
| `ENABLE_REVIEW_BY_COMMENT` | No | Enable the `/review` comment trigger (default: `true`) |
| `ENABLE_REVIEW_BY_MR_OPEN` | No | Enable the PR/MR open/reopen/sync trigger (default: `true`) |
| `ENABLE_FIX_BY_COMMENT` | No | Enable the `/fix` comment trigger (default: `false`) |
| `WORKSPACE_DIR` | No | Where repos are cloned (default: `/tmp/ai-reviewer/workspace`) |
| `WORKER_CONCURRENCY` | No | Jobs processed in parallel per worker (default: `3`) |
| `GIT_TIMEOUT_MS` | No | Timeout per git command; raise for very large repos (default: `300000`) |
| `QUEUE_JOB_TTL_SECONDS` | No | How long finished jobs are kept in Redis (default: `86400`) |
| `QUEUE_MAX_JOBS_RETAINED` | No | Max finished jobs kept in Redis (default: `100`) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token for notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat to notify |
| `PORT` | No | Server port (default: `3000`) |
| `LOG_LEVEL` | No | `trace`, `debug`, `info` (default), `warn`, `error`, `fatal` |
| `NODE_ENV` | No | `development` (default), `production`, `test` |

Feature flags accept `true`, `false`, `1` or `0`.

> **Note**: All four GitHub/GitLab credentials are always required — the process refuses to start if any is missing. If you only use one platform, set dummy values for the other.

> **Note**: `/fix` pushes commits directly to the PR/MR branch, so `GITHUB_ACCESS_TOKEN`/`GITLAB_ACCESS_TOKEN` need write (not just read) access to the repository when `ENABLE_FIX_BY_COMMENT=true`.

### Telegram notifications

Set both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (one without the other fails validation) to get a message when a review or fix completes or fails. Failures are only reported once a job has exhausted its retries.

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

Calls any OpenAI-compatible Chat Completions API (OpenAI, [9Router](https://9router.com), OpenRouter, Ollama, ...). Requires `OPENAI_API_KEY` and `OPENAI_BASE_URL`; set `OPENAI_MODEL` to a model your provider serves. The endpoint must support `response_format: { type: "json_object" }`.

The old `NINE_ROUTER_API_KEY` / `NINE_ROUTER_BASE_URL` / `NINE_ROUTER_MODEL` names are deprecated but still read as a fallback; a deprecation warning is logged at startup while they are set.

### `opencode`

Spawns the [`opencode`](https://opencode.ai) CLI locally. Install it first:

```bash
npm install -g opencode-ai
```

Set `AI_RUNNER=opencode` in your `.env`. The Docker image doesn't include the CLI by default — build the worker with `INSTALL_OPENCODE=true` (e.g. `INSTALL_OPENCODE=true docker compose build worker`). The worker exits at startup if the CLI can't be run.

Because the prompt contains untrusted PR content, the CLI runs with every tool denied and with this service's GitHub, GitLab, Telegram, Redis and `OPENAI_*` credentials removed from its environment. `OPENAI_API_KEY` / `OPENAI_BASE_URL` in `.env` therefore never reach the CLI — authenticate `opencode` through its own login/config instead.

## Reliability

- **Deduplication**: webhook redeliveries and MR updates without new commits don't trigger a second review — lifecycle jobs are keyed on the head commit, comment commands on the comment id.
- **Stale jobs**: if a newer commit was pushed before an automatic review starts, that review is skipped (the newer push has its own job). A `/review` comment always reviews the current head.
- **Retries**: each job gets 3 attempts with exponential backoff. Errors that can't succeed on retry (invalid input, AI provider `401`/`403`) fail immediately.
- **Workspace cleanup**: at startup the worker removes cloned workspaces older than 6 hours left behind by a crashed run.

## Production build

```bash
pnpm build      # Compiles TypeScript → dist/
pnpm start      # node dist/presentation/web/server.js
pnpm start:worker
```

## Development

```bash
pnpm typecheck      # Type check (strict)
pnpm lint           # ESLint
pnpm test           # Run all tests
pnpm test:watch     # Watch mode
pnpm test:coverage  # Coverage report
```

Integration tests mock Redis — no real Redis needed for tests.

## Project structure

```
src/
  config/               Config loading and Zod schema validation
  domain/               Interfaces and error types (no dependencies)
  application/          Use cases (review, fix) and services (prompt, parser)
  infrastructure/       Git, AI runners, queue, VCS clients, notifications, logging
  presentation/         Fastify app, routes (webhooks, health), DTOs
  worker.ts             Worker process entrypoint
tests/                  Unit and integration tests (vitest)
docs-user/              Extended user documentation
```

## License

MIT
