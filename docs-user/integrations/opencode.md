# OpenCode (AI Model)

In this project, **OpenCode** is the AI model that performs code review. It is accessed through the [9Router gateway](./9router.md) using an OpenAI-compatible API. You do not call OpenCode directly — the reviewer sends the prompt to 9Router, which routes the request to OpenCode on your behalf.

---

## How OpenCode Is Invoked

The reviewer sends a single `POST /chat/completions` request to 9Router with the model set to `opencode`. The request is structured as an OpenAI chat completion:

```typescript
{
  model: 'opencode',
  messages: [
    { role: 'user', content: '<system prompt + git diff>' }
  ],
  temperature: 0.1,
  response_format: { type: 'json_object' },
  max_tokens: 4096
}
```

`response_format: { type: 'json_object' }` instructs the model to produce only valid JSON, which the parser then validates against the review schema.

---

## Prompt Template

The complete system prompt sent to OpenCode:

```
You are an expert senior software developer and security auditor.

Analyze the following git diff, looking for:
- Security vulnerabilities (injection, XSS, SSRF, insecure deserialization, etc.)
- Memory leaks and resource management issues
- Performance bottlenecks and inefficiencies
- Race conditions and concurrency bugs
- Edge-case logical bugs and incorrect error handling
- Readability and maintainability issues that violate clean-code conventions

Do NOT comment on stylistic preferences such as tabs vs spaces, quote styles, or formatting
unless they violate a major convention.

Return your evaluation ONLY as a valid, parseable JSON object. Do NOT include markdown wraps
(like ```json), introduction text, or conclusion text.

Required output format:
{
  "comments": [
    {
      "filePath": "relative/path/to/file.ts",
      "lineNumber": 42,
      "message": "Actionable feedback explaining the issue and how to fix it.",
      "severity": "INFO | WARNING | CRITICAL"
    }
  ]
}

If there are no issues, return: { "comments": [] }
```

This is followed immediately by:

```
--- GIT DIFF ---
<filtered, trimmed diff content>
```

If the diff was truncated because it exceeded the 40 KB limit, a notice is appended:

```
[TRUNCATED: diff exceeded 40KB limit. Some files were omitted from this review.]
```

---

## Dynamic Context Injected into the Prompt

The diff content passed to OpenCode is preprocessed before insertion:

| Processing step | What happens |
|---|---|
| File filtering | Lockfiles, minified files, source maps, binary assets, and build directories are stripped |
| Context trimming | Unchanged context lines around hunks are reduced to 3 lines each |
| Size enforcement | Files are included in order until the 40 KB limit is reached; remaining files are dropped |
| Truncation notice | If any files were dropped, a notice comment is appended to the prompt |

Filtered file patterns:

```
package-lock.json, pnpm-lock.yaml, yarn.lock, composer.lock, Gemfile.lock, Cargo.lock
*.min.js, *.min.css, *.map
dist/, build/, .next/, out/
*.png, *.jpg, *.jpeg, *.gif, *.svg, *.ico, *.webp, *.bmp, *.tiff
*.ttf, *.woff, *.woff2, *.eot, *.otf
*.pdf, *.zip, *.gz, *.tar
```

---

## Response Schema

OpenCode is instructed to return a JSON object with a single `comments` array. Each element must conform to:

```json
{
  "filePath":   "string  — relative path from repo root",
  "lineNumber": "integer — line number in the new file version",
  "message":    "string  — actionable description of the issue",
  "severity":   "INFO | WARNING | CRITICAL"
}
```

### Severity Meanings

| Severity | Meaning |
|---|---|
| `INFO` | Improvement suggestion or minor issue; non-blocking |
| `WARNING` | Potential bug, security smell, or degraded maintainability |
| `CRITICAL` | Definite bug, security vulnerability, or data loss risk |

---

## Temperature Setting

Temperature is set to **0.1**, which keeps responses highly deterministic and factual. Raising it increases creativity at the cost of consistency — not recommended for code review.

---

## Model Selection

The model identifier `opencode` is sent to 9Router, which resolves it to the actual OpenCode backend. If 9Router maps a different model ID in your environment, update `OpenAiCompatibleService`:

```typescript
// src/infrastructure/ai/openai-compatible.service.ts
const payload: ChatRequest = {
  model: 'opencode',   // Change this if 9Router uses a different alias
  ...
};
```

The model name is not currently exposed as an environment variable. Adding `OPENAI_MODEL` to the config schema and reading it here would allow runtime configuration without code changes.

---

## Troubleshooting OpenCode Responses

### The model returns markdown fences around the JSON

The parser automatically strips `` ```json `` and `` ``` `` fences before parsing. This is a safety fallback — if OpenCode consistently wraps output in fences despite the instruction, the prompt already handles it.

### The model returns empty `comments: []`

- The diff may contain only filtered files (lockfiles, assets).
- The diff may have been entirely truncated.
- The model genuinely found no issues.

Check `diffBytes` in the logs to distinguish the first two cases.

### Comments have invalid line numbers

The parser does not currently enforce that `lineNumber` falls within the diff. If a comment references a line outside the changed range, it may be rejected by the VCS API (GitHub/GitLab will return a `422`). The `lineNumber` should refer to the line in the **new** (right-hand) version of the file.

### Timeout errors

The HTTP client has a 120-second timeout. If OpenCode is slow under load, increase `timeout` in `OpenAiCompatibleService` or raise worker retry delays in BullMQ.

### `AiProviderError: 9Router rate limit exceeded`

See the [9Router documentation](./9router.md) for rate limit handling.
