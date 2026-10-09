# 9Router (AI Gateway)

9Router is an API gateway that sits in front of one or more AI models and exposes a single **OpenAI-compatible** endpoint. The AI Code Reviewer communicates exclusively with 9Router — it never calls an AI model directly.

Benefits of this architecture:

- **Unified API surface** — the reviewer does not need provider-specific SDKs.
- **Failover** — 9Router can transparently switch between models when one is unavailable.
- **Rate limit management** — 9Router handles queuing and retry logic at the gateway level.
- **Model swapping** — change the underlying model without redeploying the reviewer.

---

## Configuration

### Required Environment Variables

| Variable | Description | Example |
|---|---|---|
| `OPENAI_API_KEY` | Bearer token for authenticating with 9Router | `9r_live_xxxxxxxxxxxx` |
| `OPENAI_BASE_URL` | Base URL of your 9Router instance | `https://api.9router.com/v1` |

`OPENAI_BASE_URL` has no default and must be set when `AI_RUNNER=direct`. Use `https://api.9router.com/v1` for hosted 9Router, or your own URL for a self-hosted or staging gateway.

```env
OPENAI_API_KEY=9r_live_xxxxxxxxxxxx
OPENAI_BASE_URL=https://api.9router.com/v1
```

---

## API Compatibility

9Router implements the OpenAI Chat Completions API. The reviewer uses:

```
POST {OPENAI_BASE_URL}/chat/completions
Authorization: Bearer {OPENAI_API_KEY}
Content-Type: application/json
```

Request body shape:

```json
{
  "model": "opencode",
  "messages": [
    { "role": "user", "content": "..." }
  ],
  "temperature": 0.1,
  "response_format": { "type": "json_object" },
  "max_tokens": 4096
}
```

Response shape (standard OpenAI format):

```json
{
  "choices": [
    {
      "message": { "content": "{\"comments\":[...]}" },
      "finish_reason": "stop"
    }
  ]
}
```

---

## Model Configuration

The reviewer sends `"model": "opencode"` to 9Router. 9Router is responsible for resolving this alias to an actual model backend. Consult your 9Router configuration to see which model `opencode` maps to, or change the alias your 9Router is configured to expose.

To use a different model alias without modifying source code, update `OPENAI_MODEL` in your environment (requires adding this variable to the config schema) and pass it in `OpenAiCompatibleService`.

---

## Rate Limits

9Router returns standard HTTP status codes for rate limit and capacity errors:

| Status | Meaning | Reviewer behavior |
|---|---|---|
| `429 Too Many Requests` | Rate limit exceeded | Throws `AiProviderError`; BullMQ retries the job with backoff |
| `503 Service Unavailable` | Gateway overloaded or model unavailable | Treated as a gateway error; job retried |
| `401 Unauthorized` | Invalid or missing API key | Throws `AiProviderError`; job fails permanently (retries will also fail) |
| `403 Forbidden` | API key lacks permission for the model | Same as 401 |
| `5xx` (other) | Gateway-level failure | Retried by BullMQ |

When a job exhausts its retry budget (default: 3 attempts), it moves to BullMQ's failed set and does not post any comments.

---

## Error Codes Reference

| Code | Typical cause | Action |
|---|---|---|
| 429 | Too many concurrent review requests | Reduce `WORKER_CONCURRENCY`; add backoff |
| 503 | 9Router or the upstream model is down | Check 9Router status; the reviewer will retry |
| 401/403 | `OPENAI_API_KEY` wrong or expired | Rotate the key and update `OPENAI_API_KEY` |
| 408/timeout | Model took > 120 s | Increase `timeout` in `OpenAiCompatibleService`; check model latency |

---

## Failover

9Router handles upstream failover internally. From the reviewer's perspective, it sees a single HTTP endpoint. If 9Router switches to a fallback model mid-session, the review format and schema remain unchanged as long as the fallback model is instructed to follow the same JSON output format.

No reviewer-side changes are needed to benefit from 9Router failover.

---

## Verifying Connectivity

```bash
curl -s -X POST "${OPENAI_BASE_URL}/chat/completions" \
  -H "Authorization: Bearer ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"opencode","messages":[{"role":"user","content":"Say OK"}],"max_tokens":5}' \
  | jq '.choices[0].message.content'
```

Expected output: `"OK"` (or similar). If this fails, resolve 9Router connectivity before starting the reviewer.

---

## Self-Hosted 9Router

If you run 9Router on-premises, set `OPENAI_BASE_URL` to your internal URL:

```env
OPENAI_BASE_URL=http://9router.internal:8080/v1
```

Ensure the reviewer container can reach 9Router. In Docker Compose, put both services on the same network:

```yaml
networks:
  reviewer-net:
    driver: bridge
```
