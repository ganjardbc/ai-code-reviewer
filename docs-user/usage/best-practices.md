# Best Practices

Operational guidance for running the AI Code Reviewer reliably in production.

---

## Keep Pull Requests Focused

The reviewer processes up to **40 KB of diff content**. Beyond this limit, files are truncated in order and may not be reviewed.

| PR size | Coverage |
|---|---|
| < 10 KB diff | Full coverage |
| 10–40 KB diff | Full coverage (with trimmed context) |
| > 40 KB diff | Partial — files beyond the limit are skipped |

**Recommendations:**

- Break large refactors into smaller PRs with a clear scope.
- Separate dependency updates (lockfile changes) into dedicated PRs — they are filtered out anyway and inflate diff size unnecessarily.
- Use feature flags to merge code incrementally rather than in one large PR.

---

## Minimize Token Scope on Access Tokens

Follow the principle of least privilege.

### GitHub PAT

Use only the scopes the reviewer needs:

| Scope | Required | Notes |
|---|---|---|
| `repo` | Yes | Covers `contents:read` and `pull_requests:write` |
| `admin:*` | No | Never grant |
| `delete_repo` | No | Never grant |
| `workflow` | No | Not needed |

Consider using a **GitHub App** instead of a PAT for repository-scoped permissions with short-lived tokens. See [GitHub Integration](../integrations/github.md).

### GitLab PAT

| Scope | Required | Notes |
|---|---|---|
| `api` | Yes | Required for posting discussions |
| `read_repository` | Yes | Required for clone |
| `write_repository` | No | Not needed |
| `sudo` | No | Never grant |

Use a **Project Access Token** (GitLab Premium) scoped to only the target project rather than a user-level PAT.

---

## Rotate Webhook Secrets Regularly

Webhook secrets are long-lived shared secrets. Rotate them at least:

- **Annually** as a baseline.
- **Immediately** if a secret is exposed in logs, code, or configuration management systems.
- **Upon team member departure** if the secret was known to the individual.

Rotation procedure:

1. Generate a new secret: `openssl rand -hex 32`
2. Update the secret in GitHub/GitLab webhook settings.
3. Update `GITHUB_WEBHOOK_SECRET` or `GITLAB_WEBHOOK_SECRET` in your environment.
4. Redeploy the reviewer service.
5. Verify a successful webhook delivery in the provider's Recent Deliveries tab.

---

## Monitor Workspace Disk Usage

Each review job clones a repository into `WORKSPACE_DIR`. Workspace cleanup runs in a `finally` block, so cleanup occurs even on failure. However:

- If the worker process is killed with SIGKILL, cleanup may not run.
- Large repositories (even with `--depth=1`) can temporarily consume hundreds of MB.
- Multiple concurrent workers each occupy separate workspace directories simultaneously.

**Recommendations:**

- Mount `WORKSPACE_DIR` on a dedicated volume with at least 10 GB of space.
- Add a cron job that deletes directories older than 1 hour under `WORKSPACE_DIR` as a safety net:

  ```bash
  find /tmp/ai-reviewer/workspace -mindepth 1 -maxdepth 1 -type d -mmin +60 -exec rm -rf {} +
  ```

- Monitor disk usage with an alert at 80% capacity.

---

## Tune Worker Concurrency

Worker concurrency (`WORKER_CONCURRENCY`, default: `3`) controls how many review jobs run in parallel within one worker process.

| Consideration | Recommendation |
|---|---|
| Each job clones a repo and calls the AI | Concurrency is I/O-bound, not CPU-bound |
| 9Router rate limits | If you hit 429s under load, reduce concurrency |
| Disk space | Each concurrent job uses a separate workspace; size disk accordingly |
| Memory | Node.js heap per job is small; the dominant cost is spawned git processes |

**Starting point:** `WORKER_CONCURRENCY=3` is reasonable for most deployments. Increase to 5–10 if 9Router can sustain the throughput and disk space permits.

For high-volume environments, scale horizontally by running multiple worker containers rather than increasing concurrency per process beyond 10.

---

## Log Level Recommendations

| Environment | `LOG_LEVEL` | Reason |
|---|---|---|
| Production | `info` | Captures all key events without excessive volume |
| Staging / debugging | `debug` | Adds AI response lengths, queue wait times |
| Development | `debug` | Full trace of each processing step |
| CI / test | `warn` | Suppresses noise during automated test runs |

Set `LOG_LEVEL=debug` temporarily when diagnosing a specific issue; revert to `info` afterward to avoid filling log storage.

Valid values (in ascending verbosity): `trace`, `debug`, `info`, `warn`, `error`, `fatal`.

---

## Secure Secrets in Production

- Never commit secrets to version control. Use `.env` files only for local development and exclude them via `.gitignore`.
- In Docker Compose, use the `secrets` top-level key or load env from a secrets manager.
- In Kubernetes, use `Secret` objects mounted as environment variables (not embedded in `ConfigMap`).
- Rotate `OPENAI_API_KEY` if you suspect it has been compromised.

---

## Health Check Monitoring

The reviewer exposes a health check endpoint:

```
GET /health → 200 OK { "status": "ok" }
```

Configure your load balancer, uptime monitor, or container orchestrator to poll this endpoint every 30 seconds. If it returns non-200, restart the container.

---

## Redis Persistence

BullMQ stores job state in Redis. If Redis is ephemeral (no persistence), all queued and failed jobs are lost on restart.

For production:

- Enable Redis persistence (`appendonly yes` in `redis.conf`).
- Use a managed Redis service (e.g. Redis Cloud, AWS ElastiCache) with replication.
- Back up Redis snapshots if job loss is unacceptable.

---

## Review Comment Volume

If a PR generates dozens of inline comments, it can be noisy for the developer. Consider:

- Limiting the number of comments posted per review (e.g. cap at the top 10 by severity).
- Filtering to only `WARNING` and `CRITICAL` by default, posting `INFO` only when explicitly requested.

Both are code-level enhancements to `ProcessReviewUseCase` that are not in the MVP but are straightforward to add.
