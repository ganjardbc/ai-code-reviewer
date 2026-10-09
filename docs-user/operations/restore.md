# Restore

This guide covers restoring the AI Code Reviewer from backup. Scenarios include: migrating to a new server, recovering from a Redis failure, or recovering lost configuration.

---

## What Can Be Restored

| Component | Restorable | Source |
|-----------|-----------|--------|
| Application code | Yes | Git repository |
| Configuration (`.env`) | Yes | Encrypted backup |
| Redis queue state | Yes | RDB snapshot or AOF backup |
| In-flight jobs | Partial | Jobs active during failure are lost; queued jobs can be restored from RDB/AOF |

---

## Full Restore Procedure

Follow this order. Do not start the application until all steps are complete.

### Step 1: Restore Application Code

```bash
git clone https://github.com/your-org/ai-code-reviewer.git
cd ai-code-reviewer
pnpm install
pnpm build
```

Or pull the latest Docker image:

```bash
docker pull registry.example.com/ai-code-reviewer:latest
```

### Step 2: Restore `.env` (Secrets)

Decrypt the backed-up `.env` file:

```bash
# If encrypted with GPG
gpg --decrypt /backups/ai-reviewer/env-20240115.gpg > .env

# If encrypted with age
age --decrypt -i ~/.ssh/id_ed25519 /backups/ai-reviewer/env-20240115.age > .env
```

Verify the file looks correct:

```bash
grep -E "^[A-Z_]+=.+" .env | head -5
```

> **Warning:** Never log or print the full `.env` contents. Only verify it is non-empty and correctly formatted.

### Step 3: Restore Redis Data

#### From an RDB Snapshot

```bash
# Stop the Redis container
docker compose stop redis

# Copy the RDB file into the Redis data volume
docker run --rm \
  -v ai-reviewer_redis-data:/data \
  -v /backups:/backups \
  alpine cp /backups/redis-20240115.rdb /data/dump.rdb

# Set correct ownership (Redis user is UID 999 in the official image)
docker run --rm \
  -v ai-reviewer_redis-data:/data \
  alpine chown 999:999 /data/dump.rdb

# Start Redis — it will load the snapshot on startup
docker compose start redis
```

#### From an AOF Backup

```bash
# Stop Redis
docker compose stop redis

# Copy AOF file into volume
docker run --rm \
  -v ai-reviewer_redis-data:/data \
  -v /backups:/backups \
  alpine sh -c "cp /backups/appendonly-20240115.aof /data/appendonly.aof && chown 999:999 /data/appendonly.aof"

# Ensure appendonly is enabled in redis.conf or via docker-compose command:
# command: redis-server --appendonly yes

# Start Redis
docker compose start redis
```

#### Verify Redis Data Loaded

```bash
docker compose exec redis redis-cli DBSIZE
# Should return > 0 if data was restored

docker compose exec redis redis-cli LLEN "bull:review-queue:wait"
# Shows queued (but unprocessed) jobs from before the failure
```

### Step 4: Start the Application

```bash
docker compose up -d
```

### Step 5: Verify the Restore

#### Health Check

```bash
curl -s http://localhost:3000/health | jq .
```

Expected:

```json
{
  "status": "healthy",
  "redis": "connected"
}
```

#### Verify Queue State

```bash
# Check all queue states
docker compose exec redis redis-cli LLEN "bull:review-queue:wait"
docker compose exec redis redis-cli LLEN "bull:review-queue:active"
docker compose exec redis redis-cli ZCARD "bull:review-queue:completed"
docker compose exec redis redis-cli ZCARD "bull:review-queue:failed"
```

#### Send a Test Request

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health
# Expected: 200
```

#### Review Application Logs

```bash
docker compose logs --tail=50 api
docker compose logs --tail=50 worker
```

Look for errors in the first 30 seconds after startup. Common restore issues:

- `ECONNREFUSED` for Redis → Redis not started, or wrong `REDIS_URL`
- `invalid token` → GitHub/GitLab access token in `.env` may be stale; rotate it
- `OPENAI_API_KEY` error → Verify API key is correct

---

## Partial Restore — Secrets Only

If you only need to restore the `.env` (e.g., after deploying to a new server):

```bash
gpg --decrypt /backups/env-latest.gpg > .env
# Adjust paths in .env if WORKSPACE_DIR changed
docker compose up -d
curl -s http://localhost:3000/health
```

---

## Handling In-Flight Jobs After Restore

Jobs that were in the `active` state at the time of failure are considered stale after restore. BullMQ does not automatically requeue them from an RDB snapshot because the worker lock keys may be absent.

To clean up stale active jobs:

```bash
# Move all "active" jobs back to "waiting" (requires BullMQ script)
docker compose exec redis redis-cli \
  LRANGE "bull:review-queue:active" 0 -1
# Then manually requeue with a BullMQ obliterate + re-add
```

Or simply allow them to expire via `QUEUE_JOB_TTL_SECONDS`. New webhooks will trigger new review jobs for the same PRs/MRs.
