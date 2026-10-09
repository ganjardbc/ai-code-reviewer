# Project Structure

The codebase follows Clean Architecture with four distinct layers. Dependencies flow inward: presentation → application → domain, and infrastructure → domain.

---

## Directory Tree

```
src/
├── config/
│   ├── index.ts              # Exports validated config object; reads process.env
│   └── schema.ts             # Zod schema for environment variable validation
│
├── domain/
│   └── interfaces/
│       ├── IVcsClient.ts     # Contract for VCS providers (GitHub, GitLab)
│       ├── IAiProvider.ts    # Contract for AI review providers (9Router)
│       ├── IQueueService.ts  # Contract for job queue (BullMQ)
│       └── IGitService.ts    # Contract for git operations
│
├── application/
│   ├── use-cases/
│   │   └── process-review.use-case.ts  # Orchestrates the full review flow
│   └── services/
│       ├── parser.service.ts   # Parses unified diffs, extracts file/line data
│       └── prompt.service.ts   # Builds the AI prompt, filters unreviewable files
│
├── infrastructure/
│   ├── ai/
│   │   └── openai-compatible.service.ts  # IAiProvider impl — calls 9Router API
│   ├── vcs/
│   │   ├── github.service.ts   # IVcsClient impl — GitHub API (@octokit/rest)
│   │   ├── gitlab.service.ts   # IVcsClient impl — GitLab API (@gitbeaker/rest)
│   │   └── security.ts         # HMAC signature verification for webhooks
│   ├── queue/
│   │   ├── connection.ts       # ioredis connection factory
│   │   ├── client.ts           # BullMQ Queue — enqueues review jobs
│   │   └── worker.ts           # BullMQ Worker — processes review jobs
│   ├── git/
│   │   ├── git.service.ts      # IGitService impl — git clone, diff operations
│   │   ├── workspace.manager.ts# Creates/destroys WORKSPACE_DIR/job-<uuid>
│   │   └── cleanup.ts          # cleanup() helper; called in finally blocks
│   └── logging/
│       ├── logger.ts           # Pino logger factory (pretty in dev, JSON in prod)
│       └── logger.interface.ts # ILogger interface (avoids pino coupling in domain)
│
├── presentation/
│   ├── web/
│   │   ├── app.ts              # Fastify instance factory (registers routes, plugins)
│   │   ├── server.ts           # Entry point — creates app, starts listening on PORT
│   │   └── routes/
│   │       ├── health.route.ts      # GET /health
│   │       ├── github.route.ts      # POST /webhooks/github
│   │       └── gitlab.route.ts      # POST /webhooks/gitlab
│   └── dto/
│       └── webhook.dto.ts      # Zod schemas for incoming webhook payloads
│
└── worker.ts                   # Worker entry point — starts BullMQ worker process

tests/
├── unit/                       # Tests for individual modules in isolation
├── integration/                # HTTP-level tests using supertest
└── fixtures/                   # JSON fixtures for webhook payloads
```

---

## Layer Responsibilities

### Domain Layer (`src/domain/`)

Contains **only interfaces**. No implementation, no dependencies on external libraries.

| Interface | Description |
|-----------|-------------|
| `IVcsClient` | Post review comments, fetch PR/MR diff |
| `IAiProvider` | Send diff to AI, receive structured comments |
| `IQueueService` | Enqueue review jobs |
| `IGitService` | Clone repos, generate diffs |

The domain layer defines the contract; infrastructure implements it.

### Application Layer (`src/application/`)

Orchestrates business logic. Depends only on domain interfaces — never on infrastructure implementations.

- `process-review.use-case.ts`: The core flow — fetch diff → filter files → build prompt → call AI → parse response → post comments
- `parser.service.ts`: Pure functions for working with unified diff format
- `prompt.service.ts`: Builds the system + user prompt; applies file filtering rules

### Infrastructure Layer (`src/infrastructure/`)

Implements domain interfaces using real external services. This is the only layer that imports external packages (axios, ioredis, @octokit/rest, etc.).

### Presentation Layer (`src/presentation/`)

Handles HTTP concerns: routing, request validation, response formatting. Uses Fastify.

### Config (`src/config/`)

All environment variable access happens here. No `process.env` references anywhere else in the codebase.

---

## Dependency Rules

```
presentation ──► application ──► domain ◄── infrastructure
```

- Presentation can import from application and domain
- Application can import from domain only
- Infrastructure can import from domain only
- Domain has no imports (pure interfaces)
- Config can be imported from anywhere
- No circular dependencies

Violations of these rules are caught by ESLint import rules.

---

## Where to Add New Features

### Adding a New VCS Provider (e.g., Bitbucket)

1. Create `src/infrastructure/vcs/bitbucket.service.ts` implementing `IVcsClient`
2. Add a new route `src/presentation/web/routes/bitbucket.route.ts`
3. Add signature verification in `src/infrastructure/vcs/security.ts`
4. Register the route in `src/presentation/web/app.ts`
5. Add env vars for `BITBUCKET_WEBHOOK_SECRET` and `BITBUCKET_ACCESS_TOKEN` to `src/config/schema.ts`

See [Contributing](./contributing.md#adding-a-new-vcs-provider) for the full guide.

### Adding a New AI Provider (e.g., OpenAI direct)

1. Create `src/infrastructure/ai/openai.service.ts` implementing `IAiProvider`
2. Add env vars to `src/config/schema.ts`
3. Wire up the new provider in the worker's dependency injection

### Adding a New Review Concern

Modify `src/application/services/prompt.service.ts` to adjust:
- File filtering rules
- The system prompt
- The user prompt structure

No changes to other layers are needed.

### Adding a New API Endpoint

1. Create `src/presentation/web/routes/my-feature.route.ts`
2. Register it in `src/presentation/web/app.ts`
3. Add DTOs in `src/presentation/dto/` if needed
4. Add tests in `tests/integration/`

---

## Entry Points

| File | Purpose |
|------|---------|
| `src/presentation/web/server.ts` | API server — `node dist/presentation/web/server.js` |
| `src/worker.ts` | Job worker — `node dist/worker.js` |
