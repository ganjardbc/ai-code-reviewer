# Configuration Reference

Internal configuration parameters that are set in source code (not environment variables). These cover BullMQ job options, diff processing limits, file filtering rules, and AI request parameters.

---

## BullMQ Job Options

Configured in `src/infrastructure/queue/client.ts` when adding jobs to the queue.

| Option | Value | Description |
|--------|-------|-------------|
| `attempts` | `3` | Maximum number of retry attempts before marking a job as failed |
| `backoff.type` | `exponential` | Retry delay strategy |
| `backoff.delay` | `5000` ms | Initial delay before first retry (doubles each attempt) |
| `removeOnComplete.count` | `QUEUE_MAX_JOBS_RETAINED` | Max completed jobs retained in Redis |
| `removeOnComplete.age` | `QUEUE_JOB_TTL_SECONDS` | Max age of completed jobs in seconds |
| `removeOnFail.count` | `QUEUE_MAX_JOBS_RETAINED` | Max failed jobs retained in Redis |
| `removeOnFail.age` | `QUEUE_JOB_TTL_SECONDS` | Max age of failed jobs in seconds |

### Retry Schedule

With `attempts: 3` and `delay: 5000ms` exponential backoff:

| Attempt | Delay Before Retry |
|---------|------------------|
| 1st failure | 5 seconds |
| 2nd failure | 10 seconds |
| 3rd failure | 20 seconds |
| After 3rd | Job moves to `failed` state |

### Modifying Job Options

Edit `src/infrastructure/queue/client.ts`:

```typescript
await queue.add('review', jobData, {
  attempts: 5,          // Increase retries
  backoff: {
    type: 'exponential',
    delay: 10000,       // Start at 10s instead of 5s
  },
  // ...
});
```

---

## Worker Concurrency

| Parameter | Source | Default | Description |
|-----------|--------|---------|-------------|
| `concurrency` | `WORKER_CONCURRENCY` env | `3` | Parallel jobs per worker process |

Configured in `src/infrastructure/queue/worker.ts`:

```typescript
const worker = new Worker('review-queue', processor, {
  connection,
  concurrency: config.workerConcurrency,
});
```

Higher concurrency increases throughput but also:
- Disk I/O (multiple git clones simultaneously)
- Memory (each job holds diff and AI response in memory)
- AI provider API request rate

---

## Diff Size Limit

| Parameter | Value | Location |
|-----------|-------|----------|
| Max diff size | `40 KB` (40,960 bytes) | `src/application/services/prompt.service.ts` |

When a diff exceeds 40KB, it is truncated to 40KB before being sent to the AI provider. A notice is appended to the prompt indicating truncation.

### Why 40KB?

Most LLMs have context window limits. 40KB of unified diff typically fits in a 32K–128K token context window with room for the system prompt and response. Adjust this limit based on the model you use.

### Changing the Limit

In `src/application/services/prompt.service.ts`:

```typescript
const MAX_DIFF_SIZE = 40 * 1024;  // 40KB — adjust as needed
```

---

## File Filtering Rules

Files matching these patterns are excluded from the AI review. Configured in `src/application/services/prompt.service.ts`.

### Excluded Patterns

| Category | Patterns |
|----------|---------|
| Lock files | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Gemfile.lock`, `go.sum`, `Cargo.lock`, `composer.lock`, `poetry.lock` |
| Build output | `dist/`, `build/`, `out/`, `.next/`, `.nuxt/`, `target/` |
| Minified files | `*.min.js`, `*.min.css`, `*.bundle.js` |
| Source maps | `*.map`, `*.js.map`, `*.css.map` |
| Binary formats | `.png`, `.jpg`, `.jpeg`, `.gif`, `.ico`, `.svg`, `.woff`, `.woff2`, `.ttf`, `.eot`, `.pdf`, `.zip`, `.tar`, `.gz` |
| Generated code | `*.generated.ts`, `*.generated.js`, `*.pb.go`, `*.pb.ts` |

### Customizing Filters

Add or remove patterns in `src/application/services/prompt.service.ts`:

```typescript
const EXCLUDED_PATTERNS = [
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /dist\//,
  // Add your patterns here:
  /migrations\//,      // Skip database migration files
  /\.snap$/,           // Skip test snapshots
];
```

---

## AI Request Parameters

Configured in `src/infrastructure/ai/openai-compatible.service.ts`.

| Parameter | Value | Description |
|-----------|-------|-------------|
| `model` | `gpt-4o` | Model identifier passed to 9Router |
| `temperature` | `0.2` | Lower = more deterministic, structured output |
| `max_tokens` | `4096` | Maximum tokens in the AI response |
| `response_format` | `{"type": "json_object"}` | Enforces JSON output (if supported by model/router) |

### Response Format

The AI is instructed to return a JSON object matching this schema:

```json
{
  "comments": [
    {
      "file": "src/index.ts",
      "line": 42,
      "severity": "warning",
      "message": "Description of the issue",
      "suggestion": "Optional code suggestion"
    }
  ]
}
```

| Field | Type | Required | Values |
|-------|------|----------|--------|
| `file` | string | Yes | Relative path from repo root |
| `line` | integer | Yes | Line number in the diff |
| `severity` | string | Yes | `info`, `warning`, `error` |
| `message` | string | Yes | Human-readable description |
| `suggestion` | string | No | Optional code fix suggestion |

### Adjusting Temperature

For more deterministic output (fewer hallucinated line numbers):

```typescript
temperature: 0.1,
```

For more varied, creative suggestions:

```typescript
temperature: 0.5,
```

---

## HTTP Server Configuration

Configured in `src/presentation/web/app.ts`.

| Parameter | Value | Description |
|-----------|-------|-------------|
| `trustProxy` | `true` | Trust `X-Forwarded-For` from reverse proxy |
| Request timeout | `30s` | Fastify server timeout |
| Body size limit | `10mb` | Maximum request body size (for large webhook payloads) |
| `@fastify/helmet` | Default | Adds security headers (CSP, HSTS, etc.) |

---

## Git Operation Timeouts

Configured in `src/infrastructure/git/git.service.ts`.

| Operation | Timeout | Notes |
|-----------|---------|-------|
| `git clone` | `120s` | Large repos may need more time |
| `git diff` | `30s` | Should be fast for local repos |
| `git fetch` | `60s` | Used for shallow fetches |

Adjust timeouts for slow networks or large monorepos:

```typescript
const GIT_CLONE_TIMEOUT_MS = 120_000;  // 2 minutes
```
