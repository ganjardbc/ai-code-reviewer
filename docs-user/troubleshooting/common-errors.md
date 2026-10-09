# Common Errors

Quick reference for the most frequently encountered errors. Each entry includes the error message pattern, root cause, and resolution steps.

---

## Error Reference Table

| Error | Component | Cause | Fix |
|-------|-----------|-------|-----|
| `ECONNREFUSED 127.0.0.1:6379` | API/Worker | Redis not running | Start Redis |
| `HMAC signature mismatch` | API | Wrong secret or body modified by proxy | See [Webhook Troubleshooting](./webhook.md) |
| `git clone failed` | Worker | Bad token, private repo, network | Check access token scopes |
| `AI request timeout` | Worker | 9Router slow or down | Check [AI Provider](./ai-provider.md) |
| `Invalid JSON from AI` | Worker | Model response not parseable | See [AI/OpenCode](./opencode.md) |
| `Missing permissions` | Worker | PAT lacks required scope | See GitHub/GitLab-specific guides |
| `EACCES: permission denied` | Worker | Workspace directory not writable | Fix ownership |

---

## Redis: ECONNREFUSED 127.0.0.1:6379

### Symptoms

```
Error: connect ECONNREFUSED 127.0.0.1:6379
    at TCPConnectWrap.afterConnect [as oncomplete] ...
```

API server starts but returns `503` from `/health`. Worker exits immediately after start.

### Causes and Fixes

**1. Redis container not started**

```bash
docker compose ps redis
# Status should be "running"

docker compose up -d redis
```

**2. Wrong `REDIS_URL`**

```dotenv
# Wrong (for Docker Compose — use service name, not localhost)
REDIS_URL=redis://localhost:6379

# Correct (Docker Compose internal network)
REDIS_URL=redis://redis:6379

# Correct (local development without Docker for app)
REDIS_URL=redis://127.0.0.1:6379
```

**3. Redis crashed or OOM**

```bash
docker compose logs redis | tail -50
# Look for "Out of memory" or "SIGKILL"
```

**4. Redis port not exposed**

```bash
docker compose exec redis redis-cli ping
# PONG = Redis is alive but may not be reachable on expected host:port
```

---

## HMAC Signature Mismatch

### Symptoms

```
Webhook rejected: HMAC signature mismatch
```

HTTP `401` returned for `/webhooks/github` or `/webhooks/gitlab`.

### Causes and Fixes

**1. Wrong webhook secret**

Compare the secret set in the VCS provider webhook settings with `GITHUB_WEBHOOK_SECRET` or `GITLAB_WEBHOOK_SECRET` in `.env`. They must be byte-for-byte identical (no trailing space).

**2. Reverse proxy modifying the body**

The HMAC is computed over the raw request body. Any proxy that re-encodes JSON will break it. See [Reverse Proxy](../deployment/reverse-proxy.md).

**3. Content-Type mismatch**

GitHub must be configured to send `application/json` (not `application/x-www-form-urlencoded`).

---

## Git Clone Failed

### Symptoms

```
Error: git clone exited with code 128
fatal: repository 'https://github.com/org/repo.git/' not found
```

or

```
fatal: Authentication failed for 'https://github.com/org/repo.git/'
```

### Causes and Fixes

**1. Access token lacks `repo` scope**

For private repos, the GitHub PAT needs `repo` scope. For GitLab, it needs `read_repository`.

**2. Token expired**

Rotate the token and update `GITHUB_ACCESS_TOKEN` or `GITLAB_ACCESS_TOKEN` in `.env`, then restart the worker.

**3. Organization SSO not authorized**

GitHub SSO-enforced organizations require the PAT to be authorized for that organization. Go to **Settings → Personal access tokens** and click "Configure SSO".

**4. Repository deleted or renamed**

Verify the repository URL in the webhook payload matches the actual repository.

---

## AI Request Timeout

### Symptoms

```
Error: Request timeout after 30000ms
  at openai-compatible.service.ts
```

Jobs fail with timeout errors; review comments are not posted.

### Causes and Fixes

**1. 9Router service unavailable**

```bash
curl -s -o /dev/null -w "%{http_code}" https://api.9router.io/health
```

Check [AI Provider Troubleshooting](./ai-provider.md).

**2. Diff too large**

Diffs larger than 40KB are truncated before being sent. If a truncated diff still triggers timeout, the model may be struggling with the context length.

**3. Network latency**

Check outbound network connectivity from the worker container:

```bash
docker compose exec worker curl -s https://api.9router.io/health
```

---

## Invalid JSON from AI

### Symptoms

```
Error: AI response is not valid JSON
SyntaxError: Unexpected token '<' in JSON
```

### Causes and Fixes

The AI provider returned HTML (likely an error page) or truncated JSON. See [OpenCode Troubleshooting](./opencode.md) for detailed diagnosis.

---

## Missing Permissions (Comment Posting)

### Symptoms

```
Error: Resource not accessible by personal access token
HTTP 403 from GitHub API
```

### Causes and Fixes

**GitHub:**
- Token needs `repo` scope for private repos, or `public_repo` for public repos
- For organization repos: the token may need to be granted organization access

**GitLab:**
- Token needs `api` scope (not just `read_api`)

---

## Workspace: Permission Denied

### Symptoms

```
Error: EACCES: permission denied, mkdir '/tmp/ai-reviewer/workspace/job-abc'
```

### Causes and Fixes

**1. Directory owned by root**

```bash
ls -la /tmp/ai-reviewer/
# If owned by root:
sudo chown -R 1000:1000 /tmp/ai-reviewer/workspace
```

**2. Docker volume mounted as root**

```bash
# In docker-compose.yml, explicitly set ownership via entrypoint
# Or pre-create the directory with correct ownership before starting containers
```

**3. WORKSPACE_DIR does not exist**

```bash
mkdir -p "$WORKSPACE_DIR"
```

---

## General Debugging Steps

1. **Check logs first:**
   ```bash
   docker compose logs -f --tail=100 api worker 2>&1 | grep -E "error|Error|WARN"
   ```

2. **Check health:**
   ```bash
   curl -s http://localhost:3000/health | jq .
   ```

3. **Check Redis connectivity:**
   ```bash
   docker compose exec redis redis-cli ping
   ```

4. **Check queue state:**
   ```bash
   docker compose exec redis redis-cli LLEN "bull:review-queue:failed"
   ```

5. **Enable debug logging temporarily:**
   ```bash
   LOG_LEVEL=debug docker compose up worker
   ```
