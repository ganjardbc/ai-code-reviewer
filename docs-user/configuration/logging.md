# Logging

Logging is powered by [pino](https://getpino.io), the same library Fastify uses internally. All
application code goes through a shared `ILogger` wrapper (`src/infrastructure/logging/logger.ts`)
so the underlying implementation can be swapped without touching call sites.

---

## LOG_LEVEL

| Variable | Default | Allowed values |
|---|---|---|
| `LOG_LEVEL` | `info` | `trace` `debug` `info` `warn` `error` `fatal` |

The value is validated at startup. An unrecognised value silently falls back to `info`.

### When to use each level

| Level | Numeric | Use when |
|---|---|---|
| `trace` | 10 | Extremely verbose — every function entry/exit, every byte of a webhook body. Useful only for debugging a specific integration failure. **Never enable in production.** |
| `debug` | 20 | Internal state that is useful during development: workspace paths, job payloads, HTTP request details. Disable in production unless actively diagnosing a problem. |
| `info` | 30 | Normal operational events: server started, job enqueued, job completed, Redis connected. **Recommended for production.** |
| `warn` | 40 | Recoverable anomalies: Redis reconnecting, a non-fatal cleanup failure, unexpected webhook signature (before rejecting it). |
| `error` | 50 | Failures that require attention: job failed, Redis client error, unhandled exception. Always includes the `err` field with stack trace. |
| `fatal` | 60 | Process-level failure that forces an exit. Logged immediately before the process terminates. |

---

## Development: pino-pretty

When `NODE_ENV !== 'production'`, the logger configures a pino-pretty transport automatically —
no manual setup needed.

Output is colourised, timestamps are human-readable, and `pid`/`hostname` are suppressed to
reduce noise:

```
[10:30:00.123] INFO: Server listening on http://0.0.0.0:3000
[10:30:01.456] DEBUG: Workspace created { path: '/tmp/ai-reviewer/workspace/job-3f8a1c2e-...' }
[10:30:01.789] INFO: Job dequeued { jobId: 'git-91823', name: 'review', queueWaitMs: 44 }
[10:30:15.002] INFO: Job completed { jobId: 'git-91823', name: 'review', durationMs: 13213 }
```

pino-pretty is a `devDependency`. It is not installed in the production Docker image; the runner
stage only installs production dependencies.

---

## Production: Structured JSON

When `NODE_ENV=production`, the logger emits one JSON object per line (NDJSON). This format is
directly ingestible by every major log aggregator.

```json
{"level":"info","time":1782531600000,"pid":14052,"hostname":"service-pod-3","msg":"Server listening on http://0.0.0.0:3000"}
{"level":"info","time":1782531601000,"pid":14052,"hostname":"service-pod-3","msg":"Job dequeued","jobId":"git-91823-abc-928","name":"review","enqueuedAt":1782531600956,"queueWaitMs":44}
{"level":"info","time":1782531615000,"pid":14052,"hostname":"service-pod-3","msg":"Job completed","jobId":"git-91823-abc-928","name":"review","durationMs":13213}
{"level":"error","time":1782531620000,"pid":14052,"hostname":"service-pod-3","msg":"Job failed","jobId":"git-91823-abc-929","err":{"type":"Error","message":"Repository not found","stack":"Error: Repository not found\n    at GitService..."}}
```

`time` is Unix epoch in milliseconds (`pino.stdTimeFunctions.epochTime`). Level is emitted as a
string (`"info"`, `"error"`, etc.) rather than a number because most aggregators prefer strings.

---

## Log Fields Reference

Fields that appear on most log records:

| Field | Type | Description |
|---|---|---|
| `level` | string | Log level name |
| `time` | number | Unix epoch ms (production) |
| `pid` | number | Process ID |
| `hostname` | string | Container / host name |
| `msg` | string | Human-readable message |

Fields added by specific events:

| Field | Type | Emitted on |
|---|---|---|
| `jobId` | string | Job dequeued / completed / failed |
| `name` | string | BullMQ job name |
| `enqueuedAt` | number | Job dequeued |
| `queueWaitMs` | number | Job dequeued — time spent waiting in queue |
| `durationMs` | number | Job completed / failed — wall-clock processing time |
| `attempts` | number | Job failed — how many attempts were made |
| `path` | string | Workspace created / removed |
| `err` | object | Any `error`-level log — serialised `Error` with `message` and `stack` |
| `queue` | string | Worker started |
| `concurrency` | number | Worker started |

---

## Sensitive Field Redaction

The following fields are automatically redacted with `[REDACTED]` before being written to the
output stream:

```
OPENAI_API_KEY  GITHUB_ACCESS_TOKEN  GITHUB_WEBHOOK_SECRET
GITLAB_ACCESS_TOKEN  GITLAB_WEBHOOK_SECRET  authorization  password  token  secret
```

This means you can safely log entire config or request objects without leaking credentials — but
do not introduce new secret fields under different names without adding them to the redact list in
`src/infrastructure/logging/logger.ts`.

---

## Log Aggregation

### Datadog

```yaml
# docker-compose.yml — add to api/worker service
labels:
  com.datadoghq.ad.logs: '[{"source":"nodejs","service":"ai-code-reviewer"}]'
```

Set `DD_LOGS_ENABLED=true` on the Datadog Agent and configure a Docker log collection pipeline.
Parse `time` as a date and promote `level` to a severity field in your Datadog pipeline.

### Elastic / OpenSearch (ELK)

Ship JSON logs via Filebeat using the `container` input:

```yaml
filebeat.inputs:
  - type: container
    paths:
      - /var/lib/docker/containers/*/*.log
    processors:
      - decode_json_fields:
          fields: ["message"]
          target: ""
```

Index pattern: `ai-code-reviewer-*`. Use `time` as the `@timestamp` field (convert from ms to
ISO-8601 with an ingest pipeline).

### AWS CloudWatch

Use the `awslogs` Docker log driver:

```yaml
logging:
  driver: awslogs
  options:
    awslogs-region: us-east-1
    awslogs-group: /ai-code-reviewer/production
    awslogs-stream-prefix: api
```

Create a CloudWatch Metric Filter on `"level":"error"` to trigger an alarm when error rate spikes.

### Kubernetes / Fluentd / Fluentbit

Pods writing to stdout are collected automatically by most cluster log pipelines. Label pods:

```yaml
metadata:
  labels:
    app: ai-code-reviewer
    component: api   # or worker
```

Use a Fluentbit parser for JSON and promote `level` to a structured field for severity routing.

---

## Tips

- **Keep `LOG_LEVEL=info` in production.** Dropping to `debug` on a busy instance can increase
  log volume by 10–50x and may exceed ingestion rate limits on managed log services.
- **Use `warn` or `error` alerts, not `info`.** Alert on `level: error` patterns (e.g.
  `"Job failed"`) rather than on the absence of `"Job completed"` messages.
- **Parse `durationMs` as a metric.** `"Job completed"` log lines carry `durationMs`, which you
  can convert into a latency histogram in your observability platform without adding a separate
  metrics library.
- **`fatal` always precedes a crash.** Set up an alert on `level: fatal` with zero tolerance —
  each one means the process exited.
