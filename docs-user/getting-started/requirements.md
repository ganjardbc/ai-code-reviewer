# Requirements

This page lists every prerequisite for running AI Code Reviewer. Check each item before proceeding to [Installation](installation.md).

---

## Runtime Prerequisites

| Dependency | Minimum Version | How to Check | Notes |
|---|---|---|---|
| Node.js | 22.x | `node --version` | LTS release recommended; v22 is required for native `fetch`, structured clone, and modern `fs` APIs used throughout the codebase |
| pnpm | 9.x | `pnpm --version` | Used for all package management; `npm` and `yarn` are not supported |
| Redis | 7.x | `redis-server --version` | Required for BullMQ job queue; can be run via Docker (see below) |
| Git | 2.x | `git --version` | Must be on `PATH`; used by `simple-git` to clone repositories and generate diffs |

---

## Optional Prerequisites

| Dependency | Minimum Version | Notes |
|---|---|---|
| Docker | 24.x | Required only for containerized deployment or for running Redis via `docker compose up redis` |
| Docker Compose | v2 (plugin) | Included with Docker Desktop; used for the bundled `docker-compose.yml` |

---

## External Service Access

The worker process makes outbound HTTPS connections to the following external services. These must be reachable from the host where the worker runs.

| Service | URL / Domain | Purpose | Credential |
|---|---|---|---|
| 9Router API | `OPENAI_BASE_URL` (e.g., `https://api.9router.com/v1`) | Sends diffs for AI review, receives structured comment JSON | `OPENAI_API_KEY` |
| GitHub API | `https://api.github.com` | Posts inline review comments on pull requests | `GITHUB_ACCESS_TOKEN` |
| GitLab API | Your GitLab instance (self-managed or `https://gitlab.com`) | Posts inline review comments on merge requests | `GITLAB_ACCESS_TOKEN` |
| GitHub / GitLab (clone) | Source repository host | Clones the repository to generate the diff | Same access token as above |

---

## Credentials Checklist

Before starting the service you need the following credentials in hand:

- [ ] **9Router API key** — obtain from your 9Router account dashboard; set as `OPENAI_API_KEY`
- [ ] **9Router base URL** — the API endpoint root; set as `OPENAI_BASE_URL`
- [ ] **GitHub personal access token** — requires `repo` scope (to clone private repos and post comments); set as `GITHUB_ACCESS_TOKEN`
- [ ] **GitHub webhook secret** — a random string you choose and configure on both the GitHub webhook and in `.env`; set as `GITHUB_WEBHOOK_SECRET`
- [ ] **GitLab personal access token** — requires `api` scope; set as `GITLAB_ACCESS_TOKEN`
- [ ] **GitLab webhook secret** — same pattern as GitHub; set as `GITLAB_WEBHOOK_SECRET`

> If you are only integrating with GitHub, you can leave the GitLab variables empty (and vice versa). The service will simply ignore webhook events that fail signature validation.

---

## Operating System

| Platform | Status |
|---|---|
| Linux (x86\_64, arm64) | Fully supported; recommended for production |
| macOS (Apple Silicon, Intel) | Supported for local development |
| Windows (WSL2) | Supported for local development via WSL2; native Windows is untested |

---

## Port Availability

The API server listens on port `3000` by default (configurable via `PORT`). Ensure this port is available on the host or adjust `PORT` in `.env` before starting.
