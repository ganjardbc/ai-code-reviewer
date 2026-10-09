import { z } from 'zod';

const logLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const nodeEnvs = ['development', 'production', 'test'] as const;
const aiRunners = ['direct', 'opencode'] as const;

const boolEnvVar = (defaultVal: 'true' | 'false' = 'true') =>
  z.enum(['true', 'false', '1', '0']).default(defaultVal).transform(v => v === 'true' || v === '1');

const baseSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(nodeEnvs).default('development'),
  LOG_LEVEL: z.enum(logLevels).default('info'),

  REDIS_URL: z.url({ message: 'REDIS_URL must be a valid URL' }),

  AI_RUNNER: z.enum(aiRunners).default('direct'),

  // Any OpenAI-compatible Chat Completions endpoint (OpenAI, 9Router, OpenRouter, Ollama, ...).
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY cannot be empty').optional(),
  // No default: guessing an endpoint would send the API key to the wrong vendor.
  OPENAI_BASE_URL: z
    .url({ message: 'OPENAI_BASE_URL must be a valid URL' })
    .optional(),
  OPENAI_MODEL: z
    .string()
    .default('gpt-4o-mini'),

  OPENCODE_COMMAND: z.string().default('opencode'),
  OPENCODE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  GITHUB_WEBHOOK_SECRET: z
    .string({ error: 'GITHUB_WEBHOOK_SECRET is required' })
    .min(1, 'GITHUB_WEBHOOK_SECRET cannot be empty'),
  GITHUB_ACCESS_TOKEN: z
    .string({ error: 'GITHUB_ACCESS_TOKEN is required' })
    .min(1, 'GITHUB_ACCESS_TOKEN cannot be empty'),

  GITLAB_WEBHOOK_SECRET: z
    .string({ error: 'GITLAB_WEBHOOK_SECRET is required' })
    .min(1, 'GITLAB_WEBHOOK_SECRET cannot be empty'),
  GITLAB_ACCESS_TOKEN: z
    .string({ error: 'GITLAB_ACCESS_TOKEN is required' })
    .min(1, 'GITLAB_ACCESS_TOKEN cannot be empty'),
  GITLAB_API_URL: z
    .string()
    .url('GITLAB_API_URL must be a valid URL')
    .optional(),

  ENABLE_REVIEW_BY_COMMENT: boolEnvVar(),
  ENABLE_REVIEW_BY_MR_OPEN: boolEnvVar(),
  ENABLE_FIX_BY_COMMENT: boolEnvVar('false'),

  WORKSPACE_DIR: z.string().default('/tmp/ai-reviewer/workspace'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(3),
  // Per git command. Clones and `fetch --unshallow` of large repos need well over a minute.
  GIT_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),

  QUEUE_JOB_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  QUEUE_MAX_JOBS_RETAINED: z.coerce.number().int().positive().default(100),

  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),
}).superRefine((data, ctx) => {
  if (data.AI_RUNNER === 'direct' && !data.OPENAI_API_KEY) {
    ctx.addIssue({
      code: 'custom' as const,
      path: ['OPENAI_API_KEY'],
      message: 'OPENAI_API_KEY is required when AI_RUNNER=direct',
    });
  }
  if (data.AI_RUNNER === 'direct' && !data.OPENAI_BASE_URL) {
    ctx.addIssue({
      code: 'custom' as const,
      path: ['OPENAI_BASE_URL'],
      message: 'OPENAI_BASE_URL is required when AI_RUNNER=direct (e.g. https://api.openai.com/v1)',
    });
  }
  const hasToken = !!data.TELEGRAM_BOT_TOKEN;
  const hasChatId = !!data.TELEGRAM_CHAT_ID;
  if (hasToken !== hasChatId) {
    const missing = hasToken ? 'TELEGRAM_CHAT_ID' : 'TELEGRAM_BOT_TOKEN';
    ctx.addIssue({
      code: 'custom' as const,
      path: [missing],
      message: `${missing} is required when the other TELEGRAM_* variable is set`,
    });
  }
});

export const LEGACY_AI_ENV_KEYS = {
  NINE_ROUTER_API_KEY: 'OPENAI_API_KEY',
  NINE_ROUTER_BASE_URL: 'OPENAI_BASE_URL',
  NINE_ROUTER_MODEL: 'OPENAI_MODEL',
} as const;

// Deprecated NINE_ROUTER_* names still work as a fallback; OPENAI_* wins when
// both are set. A deployment that only set NINE_ROUTER_API_KEY relied on the
// old 9Router defaults for base URL and model, so those are kept for it.
// Empty values (`OPENAI_API_KEY=` left blank in .env) count as unset so they
// neither block the fallback nor override a default.
function applyLegacyAiEnv(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const env: Record<string, unknown> = { ...input };
  for (const key of [...Object.keys(LEGACY_AI_ENV_KEYS), ...Object.values(LEGACY_AI_ENV_KEYS)]) {
    if (env[key] === '') delete env[key];
  }
  const legacyOnly = env['OPENAI_API_KEY'] === undefined && env['NINE_ROUTER_API_KEY'] !== undefined;

  env['OPENAI_API_KEY'] ??= env['NINE_ROUTER_API_KEY'];
  env['OPENAI_BASE_URL'] ??=
    env['NINE_ROUTER_BASE_URL'] ?? (legacyOnly ? 'https://api.9router.com/v1' : undefined);
  env['OPENAI_MODEL'] ??= env['NINE_ROUTER_MODEL'] ?? (legacyOnly ? 'opencode' : undefined);
  return env;
}

export const configSchema = z.preprocess(applyLegacyAiEnv, baseSchema);

export type AppConfig = z.infer<typeof configSchema>;
