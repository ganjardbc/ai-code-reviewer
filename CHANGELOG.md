# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-21

First tagged release.

### Added

- **Webhook receivers** for GitHub (`POST /webhooks/github`) and GitLab (`POST /webhooks/gitlab`) with signature/token verification and Zod payload validation.
- **Health endpoint** (`GET /health`) checking Redis connectivity and disk write access.
- **Queue-based architecture**: web server and BullMQ worker run as separate processes sharing Redis; jobs retry up to 3 times.
- **PR/MR lifecycle trigger**: automatic review on `opened`, `reopened`, `synchronize` (GitHub) and `open`, `reopen`, `update` (GitLab).
- **`/review` comment command** to trigger a review on demand, restricted to users with push rights (GitHub write/admin, GitLab Developer+).
- **`/fix` comment command** (behind `ENABLE_FIX_BY_COMMENT`) that applies AI-suggested fixes for outstanding review comments, commits, and pushes to the PR/MR branch. Skips threads already resolved, drops fixes for files outside the original comment set, and retries once on non-fast-forward pushes via rebase.
- **Pluggable AI providers** via `AI_RUNNER`:
  - `direct`: any OpenAI-compatible Chat Completions API (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`).
  - `opencode`: spawns the `opencode` CLI in a sandboxed, tool-less mode.
- **Robust AI output parsing**: handles markdown-wrapped responses and repairs malformed JSON; truncated fix responses are never applied.
- **Inline review comments** with a GitLab fallback path when inline anchoring fails.
- **Telegram notifications** for review/fix completion and failure.
- **Configurable feature flags** for review triggers.
- **Deployment tooling**: `Dockerfile`, `docker-compose.yml` (Redis, API, worker), `deploy.sh`, optional `INSTALL_OPENCODE` build arg, and a devbox network overlay.
- **Fork PR/MR support**: reviews use the platform head ref (`refs/pull/N/head`, `refs/merge-requests/IID/head`) on the base repo; `/fix` pushes to the fork.
- **Job deduplication** with deterministic BullMQ job IDs (head SHA for events, comment ID for commands); superseded event reviews are skipped and comment-triggered ones retarget the current head.
- **Stale workspace sweep** at worker startup (`job-*` older than 6h).
- `WORKER_CONCURRENCY` and `GIT_TIMEOUT_MS` tuning options.
- Project documentation: `README.md`, `CLAUDE.md`, user docs.

### Changed

- Renamed `NINE_ROUTER_*` environment variables to `OPENAI_*`. The old names still work as a deprecated fallback and emit a `DeprecationWarning`. `OPENAI_BASE_URL` has no default so a key is never sent to a guessed vendor.
- Package switched to ESM; bumped `fastify` to 5.12.5 and `@octokit/rest` to 22.
- Redis connection now preserves ACL username, decoded password, db index, and TLS.
- Redis runs with `maxmemory-policy noeviction` (BullMQ requirement).
- Dockerfile base image and dependencies updated; `wget` added to the runner image and Redis port bound to localhost.

### Fixed

- Diff is generated against the checked-out `headSha`, not the moved branch tip.
- GitLab `postReview` now throws when no comment could be posted.
- Commands on closed/merged PRs/MRs are ignored.
- Permanent errors (validation, AI 401/403) fail without retry; failure notifications are sent only on the final attempt.
- Various `/fix` edge cases found in code review.

### Security

- Comment commands require push rights and fail closed if the permission lookup errors.
- Git credentials are passed via scoped `GIT_CONFIG_*` env headers; tokens never appear in URLs, argv, `.git/config`, error text, or Redis job payloads. URL credentials are redacted from git stderr.
- Stricter branch-name validation before use in git commands; GitLab token compared via hash.
- `opencode` runner: prompt via stdin, all agent tools denied, service secrets stripped from its environment, runs in an empty sandbox directory.

[0.1.0]: https://github.com/ganjardbc/ai-code-reviewer/releases/tag/v0.1.0
