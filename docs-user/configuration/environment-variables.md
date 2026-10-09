# Environment Variables

All runtime configuration is loaded from environment variables at startup. The application uses
[dotenv](https://github.com/motdotla/dotenv) to read a `.env` file and validates every value
through a [Zod](https://zod.dev) schema (`src/config/schema.ts`). If validation fails, the
process exits immediately and prints every failing field — there is no silent fallback to unsafe
defaults.

---

## Complete Reference

| Variable | Type | Default | Required | Description |
|---|---|---|---|---|
| `PORT` | number | `3000` | No | TCP port Fastify listens on |
| `NODE_ENV` | enum | `development` | No | `development` / `production` / `test` |
| `LOG_LEVEL` | enum | `info` | No | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `REDIS_URL` | URL string | — | **Yes** | Full BullMQ / ioredis connection URI |
| `OPENAI_API_KEY` | string | — | **Yes** | Bearer token for the 9Router AI gateway |
| `OPENAI_BASE_URL` | URL string | — | When `AI_RUNNER=direct` | Base URL of the OpenAI-compatible endpoint, e.g. `https://api.9router.com/v1` |
| `GITHUB_WEBHOOK_SECRET` | string | — | Yes\* | HMAC-SHA256 secret configured in the GitHub webhook |
| `GITHUB_ACCESS_TOKEN` | string | — | Yes\* | GitHub PAT used to post PR review comments |
| `GITLAB_WEBHOOK_SECRET` | string | — | Yes\* | Token GitLab sends in `X-Gitlab-Token` header |
| `GITLAB_ACCESS_TOKEN` | string | — | Yes\* | GitLab PAT used to post MR notes via the API |
| `WORKSPACE_DIR` | path | `/tmp/ai-reviewer/workspace` | No | Root directory for per-job git clone subdirectories |
| `QUEUE_JOB_TTL_SECONDS` | number | `86400` | No | How long completed / failed jobs remain in Redis (seconds) |
| `QUEUE_MAX_JOBS_RETAINED` | number | `100` | No | Maximum completed + failed jobs kept in the BullMQ queue |
| `WORKER_CONCURRENCY` | number | `3` | No | Parallel review jobs processed by each worker process |

\* Required only for the respective VCS provider. You must supply at least one pair (GitHub _or_ GitLab).

---

## .env.example Walkthrough

The repository ships an `.env.example` you can copy directly:

```bash
cp .env.example .env
```

Annotated content:

```dotenv
# ── Server ────────────────────────────────────────────────────────────────────
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

# ── Redis (required) ──────────────────────────────────────────────────────────
# Must be a valid URL. ioredis parses host, port, and optional password from it.
REDIS_URL=redis://localhost:6379

# ── 9Router AI Gateway (required) ─────────────────────────────────────────────
OPENAI_API_KEY=your-9router-api-key-here
OPENAI_BASE_URL=https://api.9router.com/v1

# ── GitHub Integration ────────────────────────────────────────────────────────
# Required if you receive GitHub webhooks.
GITHUB_WEBHOOK_SECRET=your-github-webhook-secret
GITHUB_ACCESS_TOKEN=your-github-personal-access-token

# ── GitLab Integration ────────────────────────────────────────────────────────
# Required if you receive GitLab webhooks.
GITLAB_WEBHOOK_SECRET=your-gitlab-webhook-secret
GITLAB_ACCESS_TOKEN=your-gitlab-personal-access-token

# ── Worker ────────────────────────────────────────────────────────────────────
WORKSPACE_DIR=/tmp/ai-reviewer/workspace
QUEUE_JOB_TTL_SECONDS=86400
QUEUE_MAX_JOBS_RETAINED=100
```

> **Note:** `WORKER_CONCURRENCY` is not in `.env.example` because it is only read by
> `src/infrastructure/queue/worker.ts` and is typically set per-deployment (e.g. in
> `docker-compose.yml` or a Kubernetes `env` block), not in a shared `.env` file.

---

## Required vs Optional

### Always required

- `REDIS_URL` — BullMQ cannot connect without it.
- `OPENAI_API_KEY` — every review job calls the AI gateway; requests will fail with a 401 if
  this is missing.

### Provider-conditional

The application does not disable unused providers at startup. If a webhook arrives for a provider
whose secrets are absent, the HMAC validation step will fail (empty secret = rejected signature),
so the webhook is silently dropped rather than causing an unhandled error. However, best practice
is to supply both pairs and let the webhook routing choose.

### Safely optional

All other variables have code-level defaults and are safe to omit in development.

---

## Development vs Production Differences

| Concern | Development | Production |
|---|---|---|
| `NODE_ENV` | `development` | `production` |
| `LOG_LEVEL` | `debug` recommended | `info` (or `warn` for quiet logs) |
| `WORKSPACE_DIR` | `/tmp/ai-reviewer/workspace` (auto-created) | Persistent volume mount (e.g. `/workspace`) |
| `REDIS_URL` | `redis://localhost:6379` | Managed Redis URI with password (TLS recommended) |
| Secrets in `.env` | Acceptable | Use a secrets manager — do **not** bake secrets into images |
| `WORKER_CONCURRENCY` | `1`–`2` | `3`–`8` depending on CPU/memory headroom |

In production, `NODE_ENV=production` also switches the logger from pino-pretty (coloured human
output) to raw JSON lines, which is what log aggregators expect.

---

## Secrets Management

> **Warning:** Never commit real secret values to version control, even in a private repository.

### Option 1 — Environment injection at runtime (Docker / Kubernetes)

Pass secrets as environment variables through your orchestrator rather than writing them to a file
on disk:

```yaml
# Kubernetes Secret → env var
env:
  - name: OPENAI_API_KEY
    valueFrom:
      secretKeyRef:
        name: ai-reviewer-secrets
        key: nine-router-api-key
```

### Option 2 — AWS Secrets Manager / Parameter Store

Fetch at container start using an init script or a sidecar (e.g.
[aws-secrets-manager-env](https://github.com/remind101/ssm-env)):

```bash
eval $(aws ssm get-parameters-by-path \
  --path /ai-reviewer/prod \
  --with-decryption \
  --query 'Parameters[*].[Name,Value]' \
  --output text | awk '{print "export " $1 "=" $2}')
```

### Option 3 — HashiCorp Vault

Use the Vault Agent sidecar or `envconsul` to materialise secrets into environment variables
before the Node.js process starts.

### GitHub Actions / CI

Store secrets under **Settings → Secrets and variables → Actions** and reference them as
`${{ secrets.OPENAI_API_KEY }}`.

---

## Validation Errors

If any required variable is missing or fails type coercion, the process prints a structured error
and exits with code 1:

```
Error: Configuration validation failed:
  - REDIS_URL: REDIS_URL must be a valid URL
  - OPENAI_API_KEY: OPENAI_API_KEY cannot be empty
```

Fix each listed field in `.env` (or the injected environment) and restart.
