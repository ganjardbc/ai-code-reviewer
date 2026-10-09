# AI Providers

The reviewer is built around a provider abstraction that decouples the review logic from any specific AI vendor. This document explains the interface, the current implementation, and how to add a new provider.

---

## The `IAiProvider` Interface

All AI providers must implement three interfaces defined in `src/domain/interfaces/ai-provider.interface.ts`:

```typescript
export interface AiReviewComment {
  filePath: string;    // Relative path from repo root
  lineNumber: number;  // Line number in the new file version
  message: string;     // Actionable description of the issue
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
}

export interface ReviewResult {
  comments: AiReviewComment[];
}

export interface IAiProvider {
  review(prompt: string): Promise<ReviewResult>;
}
```

The `review` method receives the fully assembled prompt string (system prompt + filtered diff) and returns a structured `ReviewResult`. It must never return raw text — the provider is responsible for parsing and validating the AI output before returning.

---

## Current Implementation: OpenAiCompatibleService

`src/infrastructure/ai/openai-compatible.service.ts` implements `IAiProvider` using the 9Router gateway.

Responsibilities:

1. Build an OpenAI-compatible `ChatRequest` payload.
2. Send `POST /chat/completions` to 9Router.
3. Extract the raw text from `choices[0].message.content`.
4. Delegate parsing and schema validation to `IOutputParser` (injected via constructor).
5. Map HTTP errors to typed `AiProviderError` exceptions.

The parser (`ParserService`) is injected rather than instantiated internally so it can be swapped or tested independently.

---

## Adding a New AI Provider

### 1. Create the service file

```typescript
// src/infrastructure/ai/my-provider.service.ts
import type { IAiProvider, ReviewResult } from '../../domain/interfaces/ai-provider.interface.js';
import type { IOutputParser } from '../../application/services/parser.service.js';

export class MyProviderService implements IAiProvider {
  constructor(private readonly parser: IOutputParser) {}

  async review(prompt: string): Promise<ReviewResult> {
    // Call your AI provider's API here
    const rawText = await callMyProvider(prompt);

    // Delegate parsing to the shared parser — do not re-implement JSON validation
    return this.parser.parse(rawText);
  }
}
```

### 2. Add configuration

Add any required environment variables to `src/config/schema.ts`:

```typescript
MY_PROVIDER_API_KEY: z.string().min(1),
MY_PROVIDER_BASE_URL: z.url().optional(),
```

### 3. Register in the composition root

In `src/worker.ts` (or wherever the dependency graph is assembled), replace the `OpenAiCompatibleService` instantiation:

```typescript
// Before
const aiProvider = new OpenAiCompatibleService(parserService);

// After
const aiProvider = new MyProviderService(parserService);
```

No changes are needed to `ProcessReviewUseCase`, `PromptService`, or the queue layer — they all depend on `IAiProvider`, not a concrete class.

---

## OpenAI Direct vs 9Router

| Approach | Pros | Cons |
|---|---|---|
| 9Router gateway | Failover, model switching, no provider lock-in | Extra network hop; requires 9Router deployment |
| OpenAI directly | Simpler setup; no additional service | Requires OpenAI API key; no built-in failover |

To use OpenAI directly, implement `IAiProvider` using the `openai` npm package and point `model` at `gpt-4o` or another supported model. The prompt and response schema remain identical.

---

## Extending Prompt Templates

The prompt is built by `PromptService` (`src/application/services/prompt.service.ts`), which implements `IPromptBuilder`:

```typescript
export interface IPromptBuilder {
  build(diffText: string): string;
}
```

To customise the system prompt (e.g. add project-specific rules, change tone, or inject a language hint):

1. Create a new class that implements `IPromptBuilder`.
2. Override the `SYSTEM_PROMPT` constant or augment the assembled string.
3. Register your builder in the composition root in place of `promptService`.

Example — adding a project-specific rule:

```typescript
import { PromptService } from './prompt.service.js';

export class CustomPromptService extends PromptService {
  build(diffText: string): string {
    const base = super.build(diffText);
    return base.replace(
      '--- GIT DIFF ---',
      'Project rule: all database queries must use parameterised statements.\n\n--- GIT DIFF ---',
    );
  }
}
```

---

## Parser Reuse

`ParserService` (`src/application/services/parser.service.ts`) handles:

- Stripping accidental markdown fences.
- JSON parsing with a fallback boundary-extraction strategy.
- Ajv schema validation at the envelope level (`{ comments: [...] }`).
- Per-comment validation with dropped-comment logging.

New providers should inject and reuse `ParserService` rather than parsing responses independently. This keeps validation logic in one place and ensures consistent error handling across providers.
