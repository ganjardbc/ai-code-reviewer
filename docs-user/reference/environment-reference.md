# Environment Variable Reference

Complete reference for all environment variables. All variables are validated at startup using Zod. The application fails immediately if required variables are missing or invalid.

---

## Server

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `PORT` | integer | `3000` | No | TCP port for the Fastify HTTP server |
| `NODE_ENV` | string | `development` | No | Runtime environment. Values: `development`, `production`, `test` |
| `LOG_LEVEL` | string | `info` | No | Pino log level. Values: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |

### Examples

```dotenv
PORT=3000
NODE_ENV=production
LOG_LEVEL=info
```

### Validation Rules

- `PORT`: Must be a valid integer between 1 and 65535
- `NODE_ENV`: Must be one of `development`, `production`, `test`
- `LOG_LEVEL`: Must be one of the valid pino level strings

---

## Redis / Queue

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `REDIS_URL` | string (URL) | — | **Yes** | ioredis connection URL for BullMQ queue and health checks |
| `QUEUE_JOB_TTL_SECONDS` | integer | `86400` | No | How long to retain completed/failed jobs in Redis (seconds) |
| `QUEUE_MAX_JOBS_RETAINED` | integer | `100` | No | Maximum number of completed/failed jobs to keep in Redis |

### Examples

```dotenv
# Local Docker Redis
REDIS_URL=redis://localhost:6379

# With password
REDIS_URL=redis://:mysecretpassword@redis.internal:6379

# TLS (rediss://)
REDIS_URL=rediss://redis.internal:6380

# Keep jobs for 7 days, max 500
QUEUE_JOB_TTL_SECONDS=604800
QUEUE_MAX_JOBS_RETAINED=500
```

### Validation Rules

- `REDIS_URL`: Must be a valid URL with protocol `redis://` or `rediss://`
- `QUEUE_JOB_TTL_SECONDS`: Must be a positive integer
- `QUEUE_MAX_JOBS_RETAINED`: Must be a positive integer

---

## Worker

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `WORKER_CONCURRENCY` | integer | `3` | No | Number of review jobs processed simultaneously per worker process |

### Examples

```dotenv
WORKER_CONCURRENCY=3   # Default — good for most deployments
WORKER_CONCURRENCY=1   # Low resource usage or rate-limit situations
WORKER_CONCURRENCY=10  # High throughput, I/O-bound workloads
```

### Validation Rules

- Must be a positive integer between 1 and 50

---

## AI Provider (9Router)

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `OPENAI_API_KEY` | string | — | **Yes** | API key for authenticating with the 9Router AI gateway |
| `OPENAI_BASE_URL` | string (URL) | — | **Yes** | Base URL for the 9Router API (no trailing slash) |

### Examples

```dotenv
OPENAI_API_KEY=nr-sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENAI_BASE_URL=https://api.9router.io
```

### Validation Rules

- `OPENAI_API_KEY`: Non-empty string
- `OPENAI_BASE_URL`: Must be a valid HTTPS URL with no trailing slash

---

## GitHub Integration

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `GITHUB_WEBHOOK_SECRET` | string | — | **Yes** | HMAC-SHA256 secret shared with GitHub webhook configuration |
| `GITHUB_ACCESS_TOKEN` | string | — | **Yes** | GitHub PAT for cloning repos and posting PR comments |

### Examples

```dotenv
GITHUB_WEBHOOK_SECRET=a-long-random-string-at-least-32-chars
GITHUB_ACCESS_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Validation Rules

- `GITHUB_WEBHOOK_SECRET`: Non-empty string (minimum 16 characters recommended)
- `GITHUB_ACCESS_TOKEN`: Must match pattern `ghp_*` (classic PAT) or `github_pat_*` (fine-grained PAT)

### GitHub Token Permissions

For classic PATs: `repo` scope (or `public_repo` for public-only repos)

For fine-grained PATs:
- Repository permissions: Contents (Read), Pull requests (Read and Write)

---

## GitLab Integration

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `GITLAB_WEBHOOK_SECRET` | string | — | **Yes** | Secret token set in GitLab webhook configuration |
| `GITLAB_ACCESS_TOKEN` | string | — | **Yes** | GitLab PAT for cloning repos and posting MR discussions |

### Examples

```dotenv
GITLAB_WEBHOOK_SECRET=another-random-secret-string
GITLAB_ACCESS_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
```

### Validation Rules

- `GITLAB_WEBHOOK_SECRET`: Non-empty string
- `GITLAB_ACCESS_TOKEN`: Must match pattern `glpat-*`

### GitLab Token Permissions

Required scopes: `api`

---

## Workspace

| Variable | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `WORKSPACE_DIR` | string (path) | `/tmp/ai-reviewer/workspace` | No | Directory where git repositories are cloned during review jobs |

### Examples

```dotenv
# Default
WORKSPACE_DIR=/tmp/ai-reviewer/workspace

# Custom location with more disk space
WORKSPACE_DIR=/data/ai-reviewer/workspace
```

### Validation Rules

- Must be an absolute path (starts with `/`)
- The directory must be writable by the process user
- Should be on a local disk (NFS mounts significantly slow down git clone)

---

## Summary Table

| Variable | Required | Has Default |
|----------|----------|------------|
| `PORT` | No | Yes (`3000`) |
| `NODE_ENV` | No | Yes (`development`) |
| `LOG_LEVEL` | No | Yes (`info`) |
| `REDIS_URL` | **Yes** | No |
| `QUEUE_JOB_TTL_SECONDS` | No | Yes (`86400`) |
| `QUEUE_MAX_JOBS_RETAINED` | No | Yes (`100`) |
| `WORKER_CONCURRENCY` | No | Yes (`3`) |
| `OPENAI_API_KEY` | **Yes** | No |
| `OPENAI_BASE_URL` | **Yes** | No |
| `GITHUB_WEBHOOK_SECRET` | **Yes** | No |
| `GITHUB_ACCESS_TOKEN` | **Yes** | No |
| `GITLAB_WEBHOOK_SECRET` | **Yes** | No |
| `GITLAB_ACCESS_TOKEN` | **Yes** | No |
| `WORKSPACE_DIR` | No | Yes (`/tmp/ai-reviewer/workspace`) |

---

## Minimal `.env` for Production

```dotenv
NODE_ENV=production
LOG_LEVEL=info
REDIS_URL=redis://redis:6379
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.9router.io
GITHUB_WEBHOOK_SECRET=your_github_webhook_secret
GITHUB_ACCESS_TOKEN=ghp_your_token
GITLAB_WEBHOOK_SECRET=your_gitlab_webhook_secret
GITLAB_ACCESS_TOKEN=glpat-your_token
```
