# OpenCode / AI Response Troubleshooting

The AI review step parses the model's response as structured JSON. This document covers problems that arise when the model returns unexpected output.

---

## AI Returns Non-JSON

### Symptom

```
Error: AI response is not valid JSON
SyntaxError: Unexpected token '<', "<!DOCTYPE"... is not valid JSON
```

or

```
Error: AI response is not valid JSON
SyntaxError: Unexpected end of JSON input
```

### Causes

| Cause | How to Identify |
|-------|----------------|
| 9Router returned an HTML error page | Response starts with `<!DOCTYPE` |
| Model hit context window limit | Truncated at odd point |
| Upstream gateway error (Cloudflare, etc.) | `{"error": ...}` wrapper |
| Model streamed partial response | JSON ends abruptly |

### Diagnosis

Enable debug logging to see the raw AI response:

```bash
LOG_LEVEL=debug docker compose up worker 2>&1 | grep -A 20 "AI response"
```

If the response is HTML, the problem is at the provider level — see [AI Provider Troubleshooting](./ai-provider.md).

### Fix

1. **Retry the job** — transient errors usually self-resolve on the next webhook event (re-open/re-push the PR/MR triggers a new job)
2. **Check the prompt** — if the model consistently returns non-JSON, the system prompt may not be enforcing JSON output format clearly
3. **Check `response_format`** — if the 9Router / model supports `response_format: {type: "json_object"}`, enable it in `src/infrastructure/ai/openai-compatible.service.ts`

---

## AI Returns Empty Comments Array

### Symptom

The review job completes successfully, but no comments appear on the PR/MR. In the logs:

```
Review completed: 0 comments posted
```

### Causes

1. **All files were filtered out** — The diff contains only files that are excluded from review (lockfiles, dist/, minified JS, source maps, binary files)
2. **Diff is below minimum size** — Very small diffs (single whitespace change) may produce no actionable comments
3. **Model returned `{"comments": []}` genuinely** — The AI found no issues in the diff

### Debugging

Check the logs for what was sent to the AI:

```bash
LOG_LEVEL=debug docker compose logs worker | grep -A 5 "filtered files"
```

If all files are filtered:

```
Files filtered from review: package-lock.json, dist/bundle.min.js
Remaining files for review: 0
Skipping AI call — no reviewable files
```

**Fix:** If real source files are being filtered incorrectly, check the filtering rules in `src/application/services/prompt.service.ts`.

### Filtered File Patterns

The following file patterns are excluded by default:

| Pattern | Reason |
|---------|--------|
| `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` | Lock files — not actionable |
| `dist/`, `build/`, `out/` | Compiled output — not source |
| `*.min.js`, `*.min.css` | Minified files |
| `*.map` | Source maps |
| Binary files (images, fonts, etc.) | Cannot diff meaningfully |

---

## Line Numbers Out of Range

### Symptom

Comments are posted but appear on the wrong lines, or the VCS API rejects them with:

```
GitLab: 422 Unprocessable Entity — invalid position
GitHub: 422 Unprocessable Entity — pull_request_review_comment.position is invalid
```

### Cause

The AI returned a line number that does not correspond to an actual changed line in the diff. This can happen when:

1. The diff was truncated before being sent to the AI
2. The AI hallucinated a line number
3. The diff contains added/removed context lines and the AI referenced a context line (not a changed line)

### How the Application Handles This

The application attempts to map AI-suggested line numbers to valid diff positions. When a position is invalid:

1. The inline comment attempt is skipped
2. A fallback general comment is posted on the PR/MR body

This is expected behavior, not a bug. The overall review content is preserved as a summary comment.

### Reducing Occurrence

1. Ensure the system prompt clearly instructs the model to only reference lines that appear in the diff
2. Reduce `WORKER_CONCURRENCY` if truncation is happening frequently (reduces max diff size processed)
3. Review large PRs in smaller commits

---

## Truncated Diff Notice

### Symptom

The AI review comment includes text like:

```
[Note: Diff was truncated due to size. Only the first 40KB of changes were reviewed.]
```

### Cause

The diff exceeds 40KB. The application truncates it before sending to the AI to avoid exceeding context limits.

### Fix

1. **Split large PRs** — Review guidelines should encourage smaller, focused PRs
2. **Adjust truncation limit** — The limit is configurable in `src/application/services/prompt.service.ts`
3. **Prioritize changed files** — If only some files need review, consider filtering more aggressively

---

## Temperature Tuning

The model's response consistency depends on the `temperature` parameter. Lower values produce more predictable, structured output; higher values introduce creativity.

### Recommended Settings

| Use Case | Temperature | Notes |
|----------|-------------|-------|
| Code review (production) | 0.1–0.3 | High structure, consistent JSON output |
| Code review (development) | 0.5 | More varied feedback |

To adjust temperature, modify the AI provider service call in `src/infrastructure/ai/openai-compatible.service.ts`.

---

## Debugging AI Interactions

Enable debug logging to see full prompts and responses:

```bash
LOG_LEVEL=debug docker compose up worker
```

Look for log entries containing:
- `prompt` — The full prompt sent to the AI
- `ai response` — The raw response received
- `parsed comments` — The parsed comment objects

> **Warning:** Debug logs may contain sensitive code from your repositories. Do not enable debug logging in production long-term.
