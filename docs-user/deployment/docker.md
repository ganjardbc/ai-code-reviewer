# Docker Deployment

This guide covers building and running the AI Code Reviewer as a Docker container. For the full stack (Redis + API + Worker together), see [Docker Compose](../../docker-compose.yml).

---

## Multi-Stage Build Overview

The `Dockerfile` uses a 3-stage build to produce a minimal production image:

| Stage | Base | Purpose |
|-------|------|---------|
| `builder` | `node:22-alpine` | Install all deps, compile TypeScript |
| `pruner` | `node:22-alpine` | Strip devDependencies for production |
| `runner` | `node:22-alpine` | Final image — copy only compiled artifacts |

The final image runs as a non-root user (`appuser`) and contains no build tools, source TypeScript files, or dev dependencies.

---

## Building the Image

### Standard Build

```bash
docker build -t ai-code-reviewer:latest .
```

### Tagging for a Registry

```bash
docker build -t registry.example.com/ai-code-reviewer:1.0.0 .
docker push registry.example.com/ai-code-reviewer:1.0.0
```

### Build with Build Arguments (if supported)

```bash
docker build \
  --build-arg NODE_ENV=production \
  -t ai-code-reviewer:latest \
  .
```

> **Tip:** Add `--platform linux/amd64` when building on Apple Silicon (M1/M2) for deployment to x86 servers.

---

## Running the API Server

```bash
docker run -d \
  --name ai-reviewer-api \
  -p 3000:3000 \
  -e PORT=3000 \
  -e NODE_ENV=production \
  -e LOG_LEVEL=info \
  -e REDIS_URL=redis://redis:6379 \
  -e OPENAI_API_KEY=your_key_here \
  -e OPENAI_BASE_URL=https://api.9router.io \
  -e GITHUB_WEBHOOK_SECRET=your_secret \
  -e GITHUB_ACCESS_TOKEN=ghp_xxxxxxxx \
  -e GITLAB_WEBHOOK_SECRET=your_secret \
  -e GITLAB_ACCESS_TOKEN=glpat-xxxxxxxx \
  -e WORKSPACE_DIR=/workspace \
  -v /host/path/workspace:/workspace \
  ai-code-reviewer:latest \
  node dist/presentation/web/server.js
```

## Running the Worker

```bash
docker run -d \
  --name ai-reviewer-worker \
  -e NODE_ENV=production \
  -e LOG_LEVEL=info \
  -e REDIS_URL=redis://redis:6379 \
  -e OPENAI_API_KEY=your_key_here \
  -e OPENAI_BASE_URL=https://api.9router.io \
  -e GITHUB_ACCESS_TOKEN=ghp_xxxxxxxx \
  -e GITLAB_ACCESS_TOKEN=glpat-xxxxxxxx \
  -e WORKSPACE_DIR=/workspace \
  -e WORKER_CONCURRENCY=3 \
  -v /host/path/workspace:/workspace \
  ai-code-reviewer:latest \
  node dist/worker.js
```

> **Warning:** The API server and worker must share the same workspace volume. If they are on separate hosts without a shared filesystem, workspace cleanup will fail silently. Use Docker Compose or a network-mounted volume in that case.

---

## Environment Variable Injection

### Using an env file

```bash
docker run -d \
  --name ai-reviewer-api \
  -p 3000:3000 \
  --env-file /etc/ai-reviewer/.env \
  -v /data/workspace:/workspace \
  ai-code-reviewer:latest \
  node dist/presentation/web/server.js
```

The `--env-file` flag reads key=value pairs (no `export` keyword, no shell quoting). Comments (lines starting with `#`) are ignored.

### Using Docker secrets (Swarm)

```bash
docker secret create github_token /path/to/token.txt

docker service create \
  --name ai-reviewer-api \
  --secret github_token \
  --env GITHUB_ACCESS_TOKEN_FILE=/run/secrets/github_token \
  ai-code-reviewer:latest \
  node dist/presentation/web/server.js
```

> **Note:** The application reads environment variables directly. If using Docker secrets via files, ensure the startup wrapper reads the secret file and exports the variable before starting the Node.js process.

---

## Volume Mounting for Workspace

The workspace directory is where git repositories are cloned during review. It must be:

1. Writable by `appuser` (UID `1000` by default)
2. Large enough to hold concurrent checkouts (`WORKER_CONCURRENCY` × repo size)
3. Shared between all worker containers

```bash
# Create host directory with correct ownership
sudo mkdir -p /data/ai-reviewer/workspace
sudo chown 1000:1000 /data/ai-reviewer/workspace

# Mount it
-v /data/ai-reviewer/workspace:/workspace
```

---

## Health Check

The Dockerfile includes a built-in health check:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
```

Check the container health status:

```bash
docker inspect --format='{{.State.Health.Status}}' ai-reviewer-api
```

Expected output: `healthy`

---

## Inspecting the Running Container

```bash
# View logs
docker logs -f ai-reviewer-api

# Open a shell (for debugging only)
docker exec -it ai-reviewer-api sh

# Check environment variables loaded
docker exec ai-reviewer-api env | grep -E 'REDIS|PORT|NODE_ENV'
```

---

## Stopping and Removing Containers

```bash
docker stop ai-reviewer-api ai-reviewer-worker
docker rm ai-reviewer-api ai-reviewer-worker
```
