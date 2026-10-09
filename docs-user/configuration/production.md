# Production Checklist

This page covers the operational concerns that go beyond getting the application to start. Work
through each section before routing real webhook traffic to the service.

---

## Secrets Management

> **Never** store real credentials in `.env` files committed to version control, baked into
> Docker images, or written to disk in plaintext on production hosts.

### Vault (HashiCorp)

Use the Vault Agent sidecar or the `envconsul` binary to materialise secrets as environment
variables before the Node.js process starts:

```bash
envconsul -config=/etc/envconsul.hcl node dist/presentation/web/server.js
```

```hcl
# envconsul.hcl
secret {
  path   = "secret/ai-code-reviewer/prod"
  format = "{{ key }}"
}
```

### AWS Secrets Manager / Parameter Store

Inject secrets at container start via an init script in your ECS task definition or a Lambda-
backed SSM sidecar:

```bash
export OPENAI_API_KEY=$(aws secretsmanager get-secret-value \
  --secret-id /ai-code-reviewer/prod/nine-router-api-key \
  --query SecretString --output text)
```

Alternatively, use the AWS Secrets Manager CSI driver for Kubernetes to mount secrets as
environment variables directly from Secrets Manager.

### Kubernetes Secrets

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: ai-code-reviewer-secrets
  namespace: ai-code-reviewer
type: Opaque
stringData:
  OPENAI_API_KEY: "YOUR_KEY"
  GITHUB_ACCESS_TOKEN: "YOUR_TOKEN"
  GITLAB_ACCESS_TOKEN: "YOUR_TOKEN"
  GITHUB_WEBHOOK_SECRET: "YOUR_SECRET"
  GITLAB_WEBHOOK_SECRET: "YOUR_SECRET"
---
# Reference in the Deployment
envFrom:
  - secretRef:
      name: ai-code-reviewer-secrets
```

Rotate secrets by updating the Kubernetes Secret and rolling the Deployment — the app validates
config at startup, so a bad rotation is caught before traffic shifts.

---

## Redis Persistence

The default Docker Compose configuration uses `allkeys-lru` eviction, which is not safe for
production. Apply these changes to your Redis deployment:

```
maxmemory-policy noeviction
appendonly yes
appendfsync everysec
```

With `noeviction`, Redis rejects write commands when memory is full instead of silently deleting
job data. BullMQ will surface this as an enqueue error, which is visible and alertable.

With AOF enabled (`appendonly yes`) and `appendfsync everysec`, you lose at most one second of
Redis state on a hard crash — acceptable for a code-review queue.

**Managed Redis note:** On Redis Cloud, ElastiCache, and Upstash, configure the eviction policy
at the database / cluster level in the provider's UI or API rather than via `redis-server` flags.

---

## maxmemory Sizing

Size `maxmemory` based on your expected concurrent jobs and job retention settings:

| Factor | Memory impact |
|---|---|
| Active jobs (in-progress) | ~5–20 KB each (payload + metadata) |
| Retained completed jobs | `QUEUE_MAX_JOBS_RETAINED` × ~5 KB |
| BullMQ internal keys | ~2–5 MB overhead |
| ioredis connection state | ~1–2 MB per process |

For most deployments, 256 MB is sufficient for the queue data. Set a generous ceiling and alert
when usage exceeds 70%.

---

## Reverse Proxy and TLS

The application does not handle TLS termination itself. Terminate TLS at the edge with nginx,
Caddy, or Traefik.

**nginx example:**

```nginx
server {
    listen 443 ssl http2;
    server_name reviewer.yourdomain.com;

    ssl_certificate     /etc/ssl/certs/reviewer.crt;
    ssl_certificate_key /etc/ssl/private/reviewer.key;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

**Important:** GitHub and GitLab webhook deliveries require HTTPS. HTTP-only endpoints will be
rejected by GitHub's webhook delivery system.

### Webhook Secret Rotation

Webhook secrets (`GITHUB_WEBHOOK_SECRET`, `GITLAB_WEBHOOK_SECRET`) are validated per request
using HMAC-SHA256. To rotate:

1. Generate a new secret: `openssl rand -hex 32`
2. Update the secret in GitHub / GitLab webhook settings.
3. Update the secret in your secrets manager.
4. Rolling-restart the `api` service.

There is a brief window where in-flight deliveries signed with the old secret will be rejected.
GitHub replays failed deliveries automatically; GitLab does not.

---

## Non-Root Container

The production Docker image already runs as `appuser` (created in the runner stage). Verify this
is not overridden in your orchestrator:

```bash
# Confirm the running process is not root
docker compose exec api id
# Expected: uid=100(appuser) gid=101(appgroup) groups=101(appgroup)
```

In Kubernetes, enforce non-root at the pod level:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 100
  runAsGroup: 101
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
```

If using `readOnlyRootFilesystem: true`, mount the workspace volume at `/workspace` explicitly —
the app writes only to that path.

---

## Disk Watchdog

Orphaned `job-*` directories can accumulate if cleanup fails non-fatally. Add a periodic cleanup
cron to avoid filling the workspace volume:

```bash
# Remove job directories older than 24 hours (safe; active jobs run < 5 minutes)
find /workspace -maxdepth 1 -name 'job-*' -type d -mmin +1440 -exec rm -rf {} +
```

On Kubernetes, run this as a `CronJob`:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: workspace-cleanup
spec:
  schedule: "0 * * * *"   # every hour
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: cleanup
              image: alpine:3.20
              command:
                - sh
                - -c
                - "find /workspace -maxdepth 1 -name 'job-*' -type d -mmin +1440 -exec rm -rf {} +"
              volumeMounts:
                - name: workspace
                  mountPath: /workspace
          volumes:
            - name: workspace
              persistentVolumeClaim:
                claimName: ai-code-reviewer-workspace
          restartPolicy: OnFailure
```

Alert when the workspace volume exceeds 70% usage.

---

## Log Aggregation

Structured JSON logs (enabled automatically when `NODE_ENV=production`) are ready for ingestion
by any major platform. Key recommendations:

- **Ship `stdout` / `stderr`** via your orchestrator's log driver — do not write to files inside
  the container.
- **Parse `time` as a timestamp** — it is Unix epoch in milliseconds. Convert to ISO-8601 in
  your ingestion pipeline.
- **Index `jobId`** as a keyword field for fast job tracing across `api` and `worker` logs.
- **Alert on `level: error`** — specifically the `"Job failed"` message pattern.
- **Alert on `level: fatal`** — each occurrence means the process exited.

See [Logging](./logging.md) for aggregation configs for Datadog, ELK, and CloudWatch.

---

## Health Monitoring

The `/health` endpoint returns JSON and uses HTTP status codes correctly:

| Condition | HTTP status | Body |
|---|---|---|
| Redis up, disk up | `200 OK` | `{"status":"healthy",...}` |
| Either service down | `503 Service Unavailable` | `{"status":"unhealthy",...}` |

Configure your uptime monitor or load balancer health check against `/health`:

```
GET https://reviewer.yourdomain.com/health
Expected status: 200
Failure threshold: 2 consecutive failures
Check interval: 30s
Alert: PagerDuty / Slack on first failure
```

Docker Compose and Kubernetes liveness probes can use this endpoint directly:

```yaml
# Kubernetes
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 15
  periodSeconds: 30
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 10
  failureThreshold: 1
```

---

## Production Pre-Launch Checklist

- [ ] All secrets loaded from a secrets manager — no plaintext values in image layers or `.env`
      files on disk
- [ ] `REDIS_URL` points to a managed or dedicated Redis instance with TLS (`rediss://`)
- [ ] Redis configured with `maxmemory-policy noeviction` and AOF persistence enabled
- [ ] Redis `maxmemory` sized with a >30% headroom and a usage alert set at 70%
- [ ] HTTPS termination at the reverse proxy; HTTP redirects to HTTPS
- [ ] Webhook URLs in GitHub / GitLab point to the HTTPS endpoint
- [ ] `NODE_ENV=production` confirmed (JSON logging active, pino-pretty not loaded)
- [ ] `LOG_LEVEL=info` or `warn` (not `debug` or `trace`)
- [ ] Log aggregation pipeline connected and `jobId` indexed
- [ ] Alerts configured on `level: error` and `level: fatal` log patterns
- [ ] `/health` endpoint monitored by an external uptime tool
- [ ] Container running as non-root (`appuser`, UID 100)
- [ ] Workspace volume mounted at `/workspace` with sufficient free space (≥ 5 GB recommended)
- [ ] Disk usage alert on workspace volume at 70% threshold
- [ ] Workspace cleanup cron job deployed
- [ ] `QUEUE_JOB_TTL_SECONDS` and `QUEUE_MAX_JOBS_RETAINED` tuned to your retention requirements
- [ ] `WORKER_CONCURRENCY` set based on available CPU cores and workspace disk budget
