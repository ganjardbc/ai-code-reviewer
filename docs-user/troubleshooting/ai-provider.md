# AI Provider (9Router) Troubleshooting

The AI Code Reviewer sends code diffs to 9Router, which routes the request to an underlying large language model. This document covers connection errors, authentication failures, rate limiting, and response format issues.

---

## Overview

9Router acts as an AI gateway. The application calls it via `src/infrastructure/ai/openai-compatible.service.ts` using:

- `OPENAI_BASE_URL` — Base URL of the 9Router API
- `OPENAI_API_KEY` — Authentication key

All AI provider errors result in the review job failing. BullMQ will retry the job according to the retry configuration.

---

## Connection Errors

### Symptom

```
Error: connect ECONNREFUSED <ip>:<port>
Error: getaddrinfo ENOTFOUND api.9router.io
Error: Request failed with status code 0 (Network Error)
```

### Diagnosis

```bash
# Test from the worker container
docker compose exec worker curl -s -o /dev/null -w "%{http_code}" \
  "$OPENAI_BASE_URL/health"

# Test basic DNS resolution
docker compose exec worker nslookup api.9router.io

# Test outbound HTTPS connectivity
docker compose exec worker curl -s https://api.9router.io
```

### Causes and Fixes

| Cause | Fix |
|-------|-----|
| `OPENAI_BASE_URL` is wrong | Verify the URL in `.env` (no trailing slash) |
| No outbound internet access from container | Check Docker network and firewall rules |
| DNS resolution failing | Use a reliable DNS server (8.8.8.8) in Docker daemon config |
| 9Router service is down | Check 9Router's status page or contact support |

---

## API Key Invalid

### Symptom

```
Error: Request failed with status code 401
{"error": "Invalid API key", "code": "AUTH_FAILED"}
```

### Fix

1. Verify the key in `.env`:
   ```bash
   grep OPENAI_API_KEY .env
   ```
2. Confirm the key is active in the 9Router dashboard
3. Regenerate the key if needed and update `.env`:
   ```bash
   # Update .env
   OPENAI_API_KEY=new_key_here

   # Restart worker to pick up the new key
   docker compose restart worker
   ```

> **Note:** Environment variables are read at process startup. Changing `.env` requires a container restart.

---

## Rate Limiting (429)

### Symptom

```
Error: Request failed with status code 429
{"error": "Rate limit exceeded", "retry_after": 60}
```

### Behavior

BullMQ will retry failed jobs with exponential backoff. By default, the job retries up to 3 times with increasing delays.

### Mitigation

1. **Reduce `WORKER_CONCURRENCY`** — Fewer parallel jobs means fewer concurrent AI requests
   ```dotenv
   WORKER_CONCURRENCY=1
   ```

2. **Scale down workers** — Fewer worker containers
   ```bash
   docker compose up -d --scale worker=1
   ```

3. **Upgrade 9Router plan** — Contact 9Router for higher rate limits

4. **Add jitter to retries** — If many jobs retry simultaneously after a rate limit, they may hit the limit again. Exponential backoff with jitter helps.

---

## Request Timeout

### Symptom

```
Error: timeout of 30000ms exceeded
Error: Request timeout
```

### Diagnosis

Check if 9Router is responding slowly:

```bash
time curl -s -X POST "$OPENAI_BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "ping"}]}'
```

### Fixes

1. **Increase timeout** — Modify `src/infrastructure/ai/openai-compatible.service.ts` to increase the axios timeout
2. **Check 9Router status** — If the service is degraded, wait for recovery
3. **Switch to a faster model** — Smaller models (e.g., GPT-3.5-turbo) respond faster than GPT-4

---

## Model Not Available

### Symptom

```
Error: Request failed with status code 404
{"error": "Model 'gpt-5' not found"}
```

or

```
Error: Request failed with status code 400
{"error": "Invalid model specified"}
```

### Fix

1. Check which models are available via your 9Router account
2. Update the model identifier in `src/infrastructure/ai/openai-compatible.service.ts`
3. Verify the model name matches 9Router's documented API schema

---

## Response Format Issues

### Symptom

The job fails with a JSON parsing error, and the raw response is unexpected:

```json
{
  "choices": [{
    "message": {
      "content": "I'd be happy to review this code! Here are my thoughts:\n\n..."
    }
  }]
}
```

The content is plain text instead of structured JSON.

### Cause

The model is not following the JSON output instruction in the system prompt.

### Fix

1. **Use `response_format`** — If 9Router supports the OpenAI-compatible `response_format` parameter:
   ```typescript
   response_format: { type: "json_object" }
   ```
   Add this to the API call in `openai-compatible.service.ts`.

2. **Strengthen the prompt** — Update `src/application/services/prompt.service.ts` to more forcefully require JSON:
   ```
   You must respond with ONLY valid JSON. No explanation text, no markdown, no preamble.
   ```

3. **Lower temperature** — Set `temperature: 0.1` for more deterministic structured output.

4. **Use a model with better instruction following** — GPT-4o and Claude-series models are more reliable at JSON output than smaller models.

---

## Debugging Raw AI Requests

To see the exact payload sent to 9Router:

```bash
LOG_LEVEL=debug docker compose up worker 2>&1 | grep -A 50 "nine-router request"
```

To test the 9Router API directly:

```bash
curl -s -X POST "$OPENAI_BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "temperature": 0.2,
    "response_format": {"type": "json_object"},
    "messages": [
      {"role": "system", "content": "You are a code reviewer. Respond with JSON only: {\"comments\": []}"},
      {"role": "user", "content": "Review this: diff --git a/test.js"}
    ]
  }' | jq .
```

A successful response has `choices[0].message.content` as a JSON string containing a `comments` array.
