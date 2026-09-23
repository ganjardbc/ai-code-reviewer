# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Endpoints

- `POST /webhooks/github` — GitHub webhook receiver
- `POST /webhooks/gitlab` — GitLab webhook receiver
- `GET /health` — checks Redis connectivity and disk write access on `WORKSPACE_DIR`; returns 200 `{ status: "healthy" }` or 503 `{ status: "unhealthy", services: { redis, disk } }`

## Commands

```bash
# Development (two separate processes required)
pnpm dev           # Fastify web server (port 3000)
pnpm dev:worker    # BullMQ worker — must run alongside server

# Quality
pnpm typecheck     # tsc --noEmit (strict, noUnusedLocals, noUnusedParameters)
pnpm lint          # eslint src --ext .ts
pnpm test          # vitest run (all tests)
pnpm test:watch    # vitest (watch mode)

# Run a single test file
pnpm vitest run tests/unit/parser.service.test.ts

# Build & production
pnpm build         # tsc → dist/
pnpm start         # node dist/presentation/web/server.js
pnpm start:worker  # node dist/worker.js
```

**Requires**: Redis (`REDIS_URL`), copy `.env.example` → `.env` before running.

## Architecture

Two independent Node.js processes share a BullMQ queue via Redis:

```
[GitHub / GitLab webhook] → POST /webhooks/github|gitlab
        ↓
   webhooks.ts (Fastify route)
        ↓  signature verified, payload parsed with Zod
   reviewQueue.addJob()  →  Redis (BullMQ)
        ↓
   QueueWorker (worker.ts process)
        ↓
   ProcessReviewUseCase.execute(JobPayload)
        ↓
   GitService.clone + checkout + generateDiff
        ↓
   PromptService.build(diff)  →  IAiProvider.review(prompt)
        ↓
   ParserService.parse(aiOutput)
        ↓
   GithubService.postReview | GitlabService.postReview
```

### Key contracts

**`JobPayload`** (`domain/interfaces/queue.interface.ts`) is the only data passed between the web process and worker. The worker requires `repoOwner`, `repoName`, `prNumber` for GitHub jobs and `projectId`, `mrIid` for GitLab jobs — these must be populated by the webhook handler. `cloneUrl` is always the **base** repo URL with no credentials; `headCloneUrl` is set only for fork PRs/MRs. `trigger` (`'event' | 'comment'`) drives stale-job handling. Never put tokens in `JobPayload` — it is persisted in Redis.

**Job dedup**: webhooks pass a deterministic BullMQ `jobId` (`dedupJobId()` in `webhooks.ts`): lifecycle events key on the head SHA, comment commands on the comment id. BullMQ silently skips an add whose id exists, so redeliveries and MR `update` events without new commits don't re-review. BullMQ rejects `:` in custom ids.

**`IGithubClient`** / **`IGitlabClient`** (`domain/interfaces/vcs-client.interface.ts`) — the use case depends only on these interfaces. Both are satisfied by singleton instances (`githubService`, `gitlabService`) injected in `worker.ts`.

**`IAiProvider`** (`domain/interfaces/ai-provider.interface.ts`) — two implementations selected by `AI_RUNNER` env var:
- `direct` → `DirectApiRunner` (HTTP to 9Router API, requires `NINE_ROUTER_API_KEY`)
- `opencode` → `OpenCodeRunner` (spawns `opencode run --format json`, parses NDJSON)

**Config validation** (`config/schema.ts`): all four VCS credentials (`GITHUB_WEBHOOK_SECRET`, `GITHUB_ACCESS_TOKEN`, `GITLAB_WEBHOOK_SECRET`, `GITLAB_ACCESS_TOKEN`) are **always required** by the Zod schema — there is no per-platform optionality. Set dummy values if only using one platform. `NINE_ROUTER_API_KEY` is validated required when `AI_RUNNER=direct` via `superRefine`.

**Worker tuning**: `WORKER_CONCURRENCY` (default `3`) and `GIT_TIMEOUT_MS` (per git command, default `300000`) are validated by the Zod schema. At startup the worker deletes `job-*` workspaces older than 6h (`WorkspaceManager.sweepStaleWorkspaces`) — leftovers from a crashed worker; the age cutoff keeps it safe with several workers sharing one volume.

### Webhook trigger flows

Two trigger types per platform, both use the same `/webhooks/github` and `/webhooks/gitlab` endpoints:

1. **PR/MR lifecycle** (`pull_request` / `Merge Request Hook`): actions `opened`, `reopened`, `synchronize` / `open`, `reopen`, `update`. Always enqueues a `review` job.
2. **Comment command** (`issue_comment` / `Note Hook`): comment body matching `/^\s*\/review\b/i` (review) or `/^\s*\/fix\b/i` (fix) on an open PR/MR. `JobPayload.jobType` (`'review' | 'fix'`) carries the distinction through the queue; the worker dispatches to `ProcessReviewUseCase` or `ProcessFixUseCase` accordingly. Job names are `github-review`/`github-fix` and `gitlab-review`/`gitlab-fix`.

Comment commands are only honored from users with push rights: GitHub `hasWriteAccess` (collaborator permission `write`/`admin`), GitLab `hasDeveloperAccess` (project access level ≥ Developer, inherited included). Others get `200 { status: 'ignored' }`; a failed permission lookup returns 500 and enqueues nothing (fail closed).

The comment trigger for GitHub requires a `getPullRequest()` API call to fetch branch info (not present in `issue_comment` payload).

**`/fix` flow** (gated by `ENABLE_FIX_BY_COMMENT`, default `false`): `ProcessFixUseCase` fetches outstanding AI-authored review comments via `IGithubClient.listOutstandingBotComments`/`IGitlabClient.listOutstandingBotComments` (comments are tagged with a hidden marker, `infrastructure/vcs/bot-marker.ts`, when posted by `postReview`), clones the PR/MR branch, reads the current content of each affected file, asks the AI provider for full corrected file content (`IAiProvider.fix`, `PromptService.buildFix`), writes the results back, commits, and pushes directly to the PR/MR's head branch — then posts a summary comment. AI-returned fixes for files outside the original outstanding-comment set are dropped as a safety guard.

- GitHub's `listOutstandingBotComments` uses the GraphQL `reviewThreads` API (not REST `pulls.listReviewComments`) so it can filter out threads already marked `isResolved` — otherwise `/fix` would keep re-fixing comments a human already resolved. GitLab's discussion notes carry a `resolved` field natively via REST.
- `GitService.push` retries once on a non-fast-forward rejection (branch moved since clone): it fetches the remote branch and rebases the local fix commit onto it before retrying. A genuine rebase conflict aborts the rebase and raises a clear `GitError` instead of leaving the workspace mid-rebase.
- **Review checkout**: `ProcessReviewUseCase` clones the base repo at `baseRef`, then `GitService.fetchRef` fetches the platform head ref (`refs/pull/N/head` / `refs/merge-requests/IID/head`) and checks out `headSha` — fork PRs work without access to the fork. Before cloning it re-reads the PR/MR head: a superseded `trigger: 'event'` job is skipped (the newer push has its own job); a `trigger: 'comment'` job is retargeted to the current head. `/fix` instead clones and pushes `headCloneUrl ?? cloneUrl`.
- **Git credentials**: pass a `GitAuth` (`gitAuthFor(job)` in `job-info.util.ts`) to `GitService`; it injects an `Authorization` header via `GIT_CONFIG_COUNT/KEY_n/VALUE_n` env vars scoped to the remote's origin. Never embed tokens in URLs or `-c` args (visible in `ps`, `.git/config`, error text). `runGit` also redacts `scheme://user:pass@` from stderr.
- **Retries**: jobs get 3 attempts. Errors whose `AppError.permanent` is true (`ValidationError`, 9Router 401/403) are rethrown as BullMQ `UnrecoverableError` by `QueueWorker`. Use cases take a `JobContext` and only send failure notifications when `isFinalAttempt` (or the error is permanent).
- Both use cases notify via the optional `INotifier` (`notifyReviewComplete/Failed`, `notifyFixComplete/Failed`) — currently implemented by `TelegramNotifier`. `job-info.util.ts` holds the shared `buildPrUrl`/`repoLabel` helpers (the GitLab URL variant still strips Basic Auth credentials from `cloneUrl`, for jobs enqueued before credentials were removed from payloads).

### Critical implementation details

- **`rawBody` buffering**: `app.ts` registers a custom JSON content-type parser that stores the raw `Buffer` on `request.rawBody` before parsing. This is required for HMAC signature verification in `verifyGithubSignature`. Do not replace Fastify's body parsing without preserving this.

- **Module format**: TypeScript compiles to ESM (`"module": "Node16"`). All internal imports must use `.js` extensions (e.g., `import ... from './foo.js'`) even though the source files are `.ts`.

- **Branch name safety**: All branch names from webhook payloads must pass `isSafeBranchName()` from `infrastructure/vcs/security.ts` before being used in git shell commands.

- **Diff limits**: `PromptService` filters lock files / binaries and hard-caps the diff at 40 KB before sending to AI. Files are filtered by pattern; context lines are trimmed to 3.

- **AI response format**: Both runners expect the AI to return JSON `{ "comments": [{ "filePath", "lineNumber", "message", "severity" }] }`. `ParserService` handles markdown-wrapped responses and schema validation. The `severity` field is passed through to VCS comments as-is; no filtering or prioritization is applied based on it.

- **GitLab `baseSha`/`startSha`**: These are optional on `JobPayload` (sourced from `diff_refs` in the webhook payload). `ProcessReviewUseCase` falls back to `headSha` for both when absent. Missing `diff_refs` produces valid but potentially less precise inline comment anchoring.

### Test setup

Integration tests (`tests/integration/`) mock `reviewQueue` and the Redis connection — no real Redis needed. Unit tests use `vitest` globals. The mock env is loaded from `tests/mocks/env.ts`.

`tsconfig.json` excludes `tests/` from compilation — test files use `tsx` directly via vitest.
