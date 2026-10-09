# Frequently Asked Questions

---

## General

### Can I use it without Docker?

Yes. Run the application directly with Node.js 22+:

```bash
pnpm install
pnpm build

# Terminal 1 — API server
pnpm start

# Terminal 2 — Worker
pnpm start:worker
```

You still need Redis running. Start it with Docker (`docker run -d -p 6379:6379 redis:7-alpine`) or install it natively.

---

### Can I use a different AI model?

Yes. The AI model is configured in `src/infrastructure/ai/openai-compatible.service.ts`. Change the `model` field in the API call to any model supported by your 9Router account.

The system prompt is designed for instruction-following models. Models tested:
- GPT-4o (recommended)
- GPT-4 Turbo
- Claude 3.5 Sonnet (via 9Router routing)

Smaller models (GPT-3.5-turbo) work but produce lower quality reviews and are more prone to JSON format errors.

---

### Why are some files not reviewed?

The application filters out files that are not reviewable code. Files excluded from review:

- **Lock files:** `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Gemfile.lock`, `go.sum`
- **Compiled/built output:** `dist/`, `build/`, `out/`, `*.min.js`, `*.min.css`
- **Source maps:** `*.map`
- **Binary files:** Images, fonts, compiled binaries

This filtering happens in `src/application/services/prompt.service.ts`. If a real source file is being filtered incorrectly, check the filtering patterns there and open an issue or PR.

---

### How do I test webhooks locally?

Use **ngrok** to create a public HTTPS tunnel to your local server:

```bash
# Install ngrok
brew install ngrok  # macOS

# Start your local API server
pnpm dev  # Runs on port 3000

# In another terminal, create a tunnel
ngrok http 3000
```

ngrok gives you a URL like `https://abc123.ngrok.io`. Use `https://abc123.ngrok.io/webhooks/github` as the webhook URL in GitHub/GitLab settings.

See [Local Development](../development/local-development.md#ngrok-webhook-testing) for full setup.

---

### What if the AI posts wrong line numbers?

When the AI suggests a comment at a line number that is not part of the diff, the application:

1. Attempts to post an inline comment at the suggested line
2. If the VCS API rejects the position, falls back to posting a general PR/MR comment

You will still receive all review feedback, but some comments may appear as general PR comments rather than inline line comments. This is handled automatically.

---

### How do I disable GitLab or GitHub if I only use one?

You cannot fully "disable" a provider in the MVP — both webhook routes are always active. Simply do not configure a webhook in the VCS platform you do not use.

If a webhook is received for a platform you haven't configured (missing secret or token), the request is rejected at the signature verification step and no job is enqueued.

To suppress the warning logs:

```dotenv
# Leave these unset — the route still exists but nothing can successfully authenticate
# GITLAB_WEBHOOK_SECRET=  ← do not set
# GITLAB_ACCESS_TOKEN=    ← do not set
```

---

### Can multiple repositories use the same instance?

Yes. The reviewer is repository-agnostic. Any repository that sends a webhook to this instance will be reviewed, provided the webhook secret matches.

For GitHub, you can configure the same webhook URL and secret on multiple repositories. For per-repository secrets, each webhook can have a different secret — but the current implementation uses a single `GITHUB_WEBHOOK_SECRET` for all GitHub webhooks.

---

### How long does a review take?

Typical durations:

| Operation | Time |
|-----------|------|
| Webhook receipt to queue | < 100ms |
| Git clone (small repo) | 2–10 seconds |
| Git clone (large repo) | 10–60 seconds |
| AI review call | 5–30 seconds |
| Posting comments | 1–5 seconds |
| **Total end-to-end** | **15–90 seconds** |

Large repositories with many files will take longer to clone. The diff is truncated at 40KB, so AI processing time is bounded regardless of diff size.

---

### What happens if the worker crashes mid-review?

1. The BullMQ job remains in `active` state momentarily
2. After the job lock expires, BullMQ moves the job back to `waiting` for retry
3. The worker retries the job (default: up to 3 attempts)
4. If all retries fail, the job moves to `failed` state
5. The workspace directory may be left on disk — run manual cleanup if needed

---

### Can I review draft PRs / MRs?

By default, the webhook is triggered for `opened`, `synchronize`, and `reopened` actions (GitHub) or `opened` and `update` events (GitLab). Draft PRs send these same events.

To skip draft PRs, add a check in `src/presentation/web/routes/` that reads the `draft: true` field from the GitHub payload and returns `202` without enqueuing a job.

---

### Why do I see `202 Accepted` but no review is posted?

`202` means the webhook was received and a job was enqueued. The review is processed asynchronously. Check:

1. Is the worker running?
   ```bash
   docker compose ps worker
   ```

2. Did the job fail?
   ```bash
   docker compose exec redis redis-cli ZCARD "bull:review-queue:failed"
   docker compose logs worker | tail -50
   ```

3. Was the diff empty or all files filtered?
   ```bash
   LOG_LEVEL=debug docker compose logs worker | grep "filtered\|reviewable"
   ```

---

### How do I change the Redis connection?

Update `REDIS_URL` in `.env`:

```dotenv
# Local Docker
REDIS_URL=redis://localhost:6379

# With password
REDIS_URL=redis://:password@redis-host:6379

# Redis Cluster (requires code changes to connection.ts)
# Not supported out of the box — use Redis Sentinel instead

# With TLS
REDIS_URL=rediss://redis-host:6380
```

---

### Can I use Redis with a password?

Yes. Update the Redis URL:

```dotenv
REDIS_URL=redis://:your_password@redis-host:6379
```

Configure Redis with a password in `redis.conf`:

```ini
requirepass your_password
```

Or via Docker Compose:

```yaml
services:
  redis:
    command: redis-server --requirepass your_password
```

---

### Is there a way to see all pending reviews?

Check the BullMQ queue state in Redis:

```bash
# Count waiting jobs
docker compose exec redis redis-cli LLEN "bull:review-queue:wait"

# List job IDs waiting
docker compose exec redis redis-cli LRANGE "bull:review-queue:wait" 0 -1
```

For a visual interface, see [Queue Operations](../operations/queue.md#bullmq-dashboard-bull-board).

---

### How do I rotate secrets?

1. Update the secret in the VCS provider webhook settings
2. Update the corresponding `.env` variable
3. Restart the API server (to pick up the new secret for signature verification):
   ```bash
   docker compose restart api
   ```

There is no downtime during secret rotation — just ensure both the VCS provider and `.env` are updated before restarting.

---

### The reviewer left a comment with incorrect code suggestions. Can I configure it?

Yes. The AI prompt is configurable in `src/application/services/prompt.service.ts`. You can:

- Adjust the system prompt to focus on specific concerns (security, performance, style)
- Restrict the number of comments per review
- Change the comment format or severity labels
- Add repository-specific coding standards to the prompt

For full details on customizing the prompt, see [Coding Standards](../development/coding-standards.md).
