# Backup

The AI Code Reviewer MVP has minimal stateful data. This document identifies what must be backed up, what can be reconstructed, and how to perform backups.

---

## What to Back Up

| Component | Priority | Notes |
|-----------|----------|-------|
| `.env` file | **Critical** | Contains all secrets; cannot be reconstructed |
| Redis data (AOF) | **Important** | Queue state, job history; loss means losing in-flight jobs |
| Source code | Optional | Already in your git repository |
| Docker image | Optional | Can be rebuilt from source |
| Workspace directory | **Not needed** | Ephemeral; cleaned up per job |

> **Note:** There is no database in the MVP. All persistent state lives in Redis and your `.env` file.

---

## Backing Up Secrets (`.env`)

Store your `.env` file in a secrets manager rather than on disk:

- **HashiCorp Vault**
- **AWS Secrets Manager**
- **Azure Key Vault**
- **1Password Secrets Automation**

If storing on disk (simpler setups):

```bash
# Copy .env to an encrypted backup
gpg --symmetric --cipher-algo AES256 .env
# Produces .env.gpg — store this file safely

# Or use age encryption
age -r "ssh-ed25519 AAAA..." .env > .env.age
```

**Never store the unencrypted `.env` file in a git repository or cloud storage without encryption.**

### What the `.env` Contains

```
OPENAI_API_KEY        → AI provider billing/access key
GITHUB_WEBHOOK_SECRET      → HMAC signing secret for GitHub
GITHUB_ACCESS_TOKEN        → GitHub PAT (access to private repos)
GITLAB_WEBHOOK_SECRET      → HMAC signing secret for GitLab
GITLAB_ACCESS_TOKEN        → GitLab PAT (access to private repos)
```

Rotate all tokens if the `.env` file is compromised.

---

## Redis Backup

### Method 1: RDB Snapshot (Default)

Redis persists data to `dump.rdb` by default. The snapshot frequency is controlled by the `save` directive in `redis.conf`.

```bash
# Trigger an immediate snapshot
docker compose exec redis redis-cli BGSAVE

# Wait for it to complete
docker compose exec redis redis-cli LASTSAVE
# Returns a Unix timestamp — compare before/after BGSAVE

# Copy the snapshot out of the container
docker cp ai-reviewer-redis:/data/dump.rdb /backups/redis-dump-$(date +%Y%m%d).rdb
```

### Method 2: AOF (Append-Only File)

AOF provides better durability — Redis logs every write operation. Enable it in `redis.conf`:

```ini
appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec   # Sync to disk every second (good balance)
```

Or enable at runtime:

```bash
docker compose exec redis redis-cli CONFIG SET appendonly yes
```

Back up the AOF file:

```bash
docker cp ai-reviewer-redis:/data/appendonly.aof /backups/redis-aof-$(date +%Y%m%d).aof
```

> **Tip:** Use both RDB + AOF for production. RDB is faster to restore; AOF provides durability between snapshots.

### Method 3: Volume Backup with Docker

```bash
# Stop Redis to ensure consistency
docker compose stop redis

# Archive the entire Redis data volume
docker run --rm \
  -v ai-reviewer_redis-data:/data \
  -v /backups:/backups \
  alpine tar czf /backups/redis-volume-$(date +%Y%m%d).tar.gz -C /data .

# Restart Redis
docker compose start redis
```

---

## Automated Backup Script

```bash
#!/bin/bash
set -euo pipefail

BACKUP_DIR="/backups/ai-reviewer"
DATE=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

# 1. Back up .env (encrypted)
gpg --symmetric --cipher-algo AES256 --batch \
  --passphrase "$BACKUP_PASSPHRASE" \
  -o "$BACKUP_DIR/env-$DATE.gpg" /opt/ai-reviewer/.env

# 2. Trigger Redis snapshot
docker compose -f /opt/ai-reviewer/docker-compose.yml exec -T redis redis-cli BGSAVE

# Wait for snapshot to complete
sleep 5

# 3. Copy Redis RDB file
docker cp ai-reviewer-redis:/data/dump.rdb "$BACKUP_DIR/redis-$DATE.rdb"

# 4. Remove backups older than 30 days
find "$BACKUP_DIR" -type f -mtime +30 -delete

echo "Backup complete: $BACKUP_DIR"
```

Schedule with cron:

```cron
0 2 * * * /usr/local/bin/ai-reviewer-backup.sh >> /var/log/ai-reviewer-backup.log 2>&1
```

---

## Backup Retention Policy

| Backup Type | Recommended Retention |
|------------|----------------------|
| Daily Redis snapshot | 7 days |
| Weekly Redis snapshot | 4 weeks |
| `.env` encrypted backup | Indefinite (small file) |

---

## What Does Not Need Backing Up

| Item | Reason |
|------|--------|
| `dist/` (compiled JS) | Rebuilt with `pnpm build` |
| `node_modules/` | Reinstalled with `pnpm install` |
| Workspace directories | Ephemeral; cleaned per job |
| Docker images | Rebuilt from `Dockerfile` + source code |
| Logs | Rotated; ship to external aggregator for long-term retention |
