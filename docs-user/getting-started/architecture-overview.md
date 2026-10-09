# Architecture Overview

## Full Architecture Diagram

```mermaid
graph TD
    subgraph External["External Systems"]
        GH[GitHub]
        GL[GitLab]
        AI[9Router / OpenCode Model]
    end

    subgraph API["API Process — Fastify :3000"]
        WH_GH[POST /webhooks/github]
        WH_GL[POST /webhooks/gitlab]
        HEALTH[GET /health]
        VALIDATION[Webhook Validation\nSignature + Schema]
    end

    subgraph QUEUE["Queue — BullMQ / Redis"]
        REDIS[(Redis 7)]
        JOB[Review Job\njob-uuid]
    end

    subgraph WORKER["Worker Process"]
        DEQUEUE[Job Dequeued]
        CLONE[Clone Repository\nsimple-git]
        DIFF[Generate Filtered Diff\nmax 40 KB]
        CALL_AI[Call 9Router API\nHTTPS POST]
        PARSE[Parse JSON Response]
        POST[Post Inline Comments\nGitHub API / GitLab API]
        CLEANUP[Cleanup Workspace\nWORKSPACE_DIR/job-uuid]
    end

    GH -->|pull_request webhook| WH_GH
    GL -->|merge_request webhook| WH_GL
    WH_GH --> VALIDATION
    WH_GL --> VALIDATION
    VALIDATION -->|202 Accepted| GH
    VALIDATION -->|202 Accepted| GL
    VALIDATION --> REDIS
    REDIS --> JOB
    JOB --> DEQUEUE
    DEQUEUE --> CLONE
    CLONE --> DIFF
    DIFF --> CALL_AI
    CALL_AI --> AI
    AI -->|{"comments":[...]}| PARSE
    PARSE --> POST
    POST --> GH
    POST --> GL
    POST --> CLEANUP
    HEALTH --> REDIS
```

---

## Layer Descriptions

The codebase follows **Clean Architecture**, dividing concerns into four layers. Dependencies point inward — outer layers may depend on inner layers, never the reverse.

### Domain Layer (`src/domain/`)

The innermost layer. Contains pure business logic with no framework or infrastructure dependencies.

- **Entities** — core data shapes: `ReviewJob`, `DiffChunk`, `ReviewComment`
- **Value Objects** — validated, immutable types: `Severity` (`INFO | WARNING | CRITICAL`), `FilePath`, `LineNumber`
- **Repository interfaces** — contracts (TypeScript interfaces) that the infrastructure layer must implement
- **Domain services** — stateless logic that operates on domain objects (e.g., diff filtering rules)

### Application Layer (`src/application/`)

Orchestrates use cases by coordinating domain objects and calling repository interfaces. Contains no HTTP, Redis, or AI SDK code.

- **Use Cases** — `ProcessReviewJobUseCase`, `ValidateWebhookUseCase`
- **DTOs** — data transfer objects that cross the boundary between layers
- **Application services** — thin wrappers that assemble use cases with injected dependencies

### Infrastructure Layer (`src/infrastructure/`)

Concrete implementations of repository interfaces and all third-party integrations.

- **Queue** — BullMQ producer (enqueues jobs) and consumer (worker loop)
- **VCS clients** — GitHub API client (Octokit), GitLab API client, simple-git wrapper
- **AI client** — HTTP client for 9Router; serializes diff, deserializes structured JSON response
- **Workspace** — temporary directory management; wraps Node.js `fs` and `os` modules

### Presentation Layer (`src/presentation/`)

Entry points that translate external protocols (HTTP, queue events) into application layer calls.

- **Fastify server** — route registration, webhook signature validation, error handling
- **Route handlers** — parse HTTP requests, call use cases, return HTTP responses
- **Worker entry point** (`src/worker.ts`) — connects to BullMQ, registers job processor, handles shutdown signals

---

## Request Lifecycle

### 1. Webhook Receipt (API Process)

```
POST /webhooks/github
  |
  +-- Validate HMAC-SHA256 signature (GITHUB_WEBHOOK_SECRET)
  |
  +-- Parse event type (pull_request: opened / synchronize / reopened)
  |
  +-- Build ReviewJobPayload { repoUrl, prNumber, headSha, baseSha, platform }
  |
  +-- Enqueue job to BullMQ
  |
  +-- Return HTTP 202 Accepted
```

### 2. Job Processing (Worker Process)

```
Job dequeued from BullMQ
  |
  +-- Create workspace: WORKSPACE_DIR/job-<uuid>/
  |
  +-- Clone repository (shallow clone, specific ref) via simple-git
  |
  +-- Generate diff: git diff baseSha..headSha
  |
  +-- Filter diff:
  |     - Remove lockfiles (package-lock.json, pnpm-lock.yaml, yarn.lock, *.lock)
  |     - Remove build output (dist/, build/, *.min.js, *.map)
  |     - Remove binary assets (images, fonts, compiled artifacts)
  |     - Enforce 40 KB size limit — abort if exceeded
  |
  +-- POST filtered diff to 9Router API
  |     Headers: Authorization: Bearer OPENAI_API_KEY
  |     Body:    { model, messages: [{ role: "user", content: diff }] }
  |
  +-- Parse response:
  |     Expected schema:
  |     {
  |       "comments": [
  |         {
  |           "filePath": "src/auth/login.ts",
  |           "lineNumber": 42,
  |           "message": "...",
  |           "severity": "WARNING"
  |         }
  |       ]
  |     }
  |
  +-- Post each comment to GitHub / GitLab API as a pull request review comment
  |
  +-- finally: rm -rf WORKSPACE_DIR/job-<uuid>/   (always runs)
```

---

## Design Principles

### Dependency Injection

All concrete implementations are injected at the composition root (process entry points). Use cases and domain services receive interfaces, not concrete classes. This makes the entire application testable without Redis, Git, or network access.

### Sandbox Isolation

Every review job operates in an isolated workspace directory (`WORKSPACE_DIR/job-<uuid>`). The `finally` block in the job processor guarantees cleanup regardless of whether the job succeeds, fails, or throws unexpectedly. Jobs cannot read each other's files.

### Structured AI Output

The AI is prompted to return a specific JSON schema. The worker validates the parsed response against that schema before attempting to post comments. Malformed responses are logged and the job is marked failed rather than posting incorrect comments.

### Input Validation at the Boundary

Webhook payloads are validated (HMAC signature + shape) at the Presentation layer before any application logic runs. Invalid or unsigned requests never reach the queue.

### Safe Subprocess Usage

`simple-git` is used instead of raw `child_process.exec` calls with shell interpolation. Repository URLs and SHAs from webhook payloads are validated against an allowlist pattern before being passed to git commands.
