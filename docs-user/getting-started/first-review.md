# First Review

This guide walks through the complete end-to-end flow of your first AI-assisted code review — from registering the webhook to seeing comments appear on a GitHub pull request. It also covers what to check when things do not work as expected.

> This guide assumes you have completed the [Quick Start](quick-start.md) or [Installation](installation.md) steps and that the API server and worker are both running.

---

## Step 1 — Confirm the Service Is Healthy

Before touching GitHub, confirm both processes are up:

```bash
curl -s http://localhost:3000/health | jq .
```

Expected output:

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "services": {
    "redis": "up",
    "disk": "up"
  }
}
```

If `redis` is `"down"`, fix the Redis connection before continuing — no jobs will be processed until Redis is reachable.

---

## Step 2 — Expose the Service Publicly

GitHub must be able to deliver webhook payloads to your service over HTTPS. If you are running locally, use a tunnel:

```bash
ngrok http 3000
```

Copy the HTTPS forwarding URL (e.g., `https://abc123.ngrok-free.app`). If you are deploying to a server with a public IP, use that server's domain or IP.

---

## Step 3 — Configure the GitHub Webhook

1. Open the repository on GitHub where you want AI reviews.
2. Go to **Settings → Webhooks → Add webhook**.
3. Fill in the form:

   | Field | Value |
   |---|---|
   | Payload URL | `https://abc123.ngrok-free.app/webhooks/github` |
   | Content type | `application/json` |
   | Secret | The value of `GITHUB_WEBHOOK_SECRET` in your `.env` |
   | Which events | **Let me select individual events** → tick **Pull requests** only |
   | Active | Checked |

4. Click **Add webhook**.

GitHub will immediately send a `ping` event. You should see it in your API server logs:

```
{"level":"info","msg":"Webhook received","event":"ping","status":200}
```

If you do not see this log line within a few seconds, the webhook URL is not reachable. Re-check the tunnel URL and make sure port 3000 is not blocked by a firewall.

---

## Step 4 — Open a Test Pull Request

Create a simple branch with a code change and open a pull request:

```bash
git checkout -b test/ai-review-demo
# Make a small change to any source file
echo "// test change" >> src/index.ts
git add src/index.ts
git commit -m "test: trigger AI review"
git push origin test/ai-review-demo
```

Then go to GitHub and open a pull request from `test/ai-review-demo` into `main` (or your default branch).

---

## Step 5 — Watch the Logs

Switch to the terminal running the **API server** and watch for:

```
{"level":"info","msg":"Webhook received","event":"pull_request","action":"opened"}
{"level":"info","msg":"Job enqueued","jobId":"job-a1b2c3d4-...","repo":"your-org/your-repo","pr":1}
{"level":"info","msg":"POST /webhooks/github","statusCode":202,"responseTime":12}
```

Then switch to the terminal running the **worker**:

```
{"level":"info","msg":"Job started","jobId":"job-a1b2c3d4-..."}
{"level":"info","msg":"Repository cloned","path":"/tmp/ai-reviewer/workspace/job-a1b2c3d4-..."}
{"level":"info","msg":"Diff generated","sizeBytes":1842,"filteredFiles":0}
{"level":"info","msg":"AI request sent"}
{"level":"info","msg":"AI response received","commentCount":3}
{"level":"info","msg":"Comments posted","count":3,"pr":1}
{"level":"info","msg":"Workspace cleaned up","path":"/tmp/ai-reviewer/workspace/job-a1b2c3d4-..."}
{"level":"info","msg":"Job completed","jobId":"job-a1b2c3d4-..."}
```

---

## Step 6 — See AI Comments on the Pull Request

Open the pull request on GitHub and navigate to the **Files changed** tab. You should see inline comments from the AI reviewer, each tagged with a severity:

- `INFO` — informational observations
- `WARNING` — potential issues worth addressing
- `CRITICAL` — likely bugs or security concerns that should be fixed before merging

The comments are posted as a pull request review. The reviewer name will be the account associated with `GITHUB_ACCESS_TOKEN`.

---

## Troubleshooting

### No comments appear on the PR

Work through this checklist in order:

**1. Did the API server receive the webhook?**

Check the API server log for a line with `"event":"pull_request"`. If it is missing:

- GitHub may not be able to reach your URL. Open the webhook in GitHub (**Settings → Webhooks**) and check the **Recent Deliveries** tab. A red `X` means delivery failed.
- Re-check the payload URL and ensure your tunnel or server is accessible.

**2. Did the webhook pass signature validation?**

If you see `{"level":"warn","msg":"Invalid webhook signature"}` in the API server log:

- The `GITHUB_WEBHOOK_SECRET` in `.env` does not match the secret configured in GitHub.
- Restart the API server after correcting `.env`.

**3. Was a job enqueued?**

Look for `"msg":"Job enqueued"` in the API server log. If it is missing but the webhook was received:

- The event action (e.g., `labeled`, `assigned`) may not be one the service handles. Only `opened`, `synchronize`, and `reopened` actions create review jobs.

**4. Did the worker pick up the job?**

Look for `"msg":"Job started"` in the worker log. If it is missing:

- The worker may not be running. Check the worker terminal.
- Redis connectivity may have been lost. Check `redis-cli ping`.

**5. Did the diff generate successfully?**

Look for `"msg":"Diff generated"` in the worker log. If you see an error instead:

- The `GITHUB_ACCESS_TOKEN` may lack `repo` scope, causing the clone to fail on private repositories.
- The diff may exceed 40 KB. Add more focused changes to the test PR.

**6. Did the AI call succeed?**

Look for `"msg":"AI response received"` in the worker log. If you see an error:

- Check `OPENAI_API_KEY` and `OPENAI_BASE_URL` in `.env`.
- Verify network access from the worker host to the 9Router API.

**7. Were comments posted?**

Look for `"msg":"Comments posted"` in the worker log. If the AI responded but no comments were posted:

- The AI may have returned an empty `comments` array (no issues found in the diff).
- The `GITHUB_ACCESS_TOKEN` may lack write access to the repository.
- Check for a `"msg":"Failed to post comments"` error in the worker log.

---

### Common Error Messages

| Log Message | Likely Cause | Fix |
|---|---|---|
| `Invalid webhook signature` | Secret mismatch | Match `GITHUB_WEBHOOK_SECRET` in `.env` and GitHub webhook settings |
| `Redis connection failed` | Redis not running or wrong URL | Start Redis; check `REDIS_URL` |
| `Clone failed: authentication required` | Token lacks `repo` scope or is expired | Re-generate `GITHUB_ACCESS_TOKEN` with `repo` scope |
| `Diff exceeds size limit` | PR changes too large (>40 KB filtered) | Split the PR into smaller pieces |
| `AI response parse error` | Unexpected response from 9Router | Check `OPENAI_BASE_URL`; verify the model supports structured output |
| `Failed to post review comment` | Token lacks write access | Confirm the token owner has write access to the repository |

---

### Checking Logs in Docker

If running via Docker Compose:

```bash
# API server logs
docker compose logs -f api

# Worker logs
docker compose logs -f worker
```
