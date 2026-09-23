import { z } from 'zod';

const logLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const nodeEnvs = ['development', 'production', 'test'] as const;
const aiRunners = ['direct', 'opencode'] as const;

const boolEnvVar = (defaultVal: 'true' | 'false' = 'true') =>
  z.enum(['true', 'false', '1', '0']).default(defaultVal).transform(v => v === 'true' || v === '1');

export const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(nodeEnvs).default('development'),
  LOG_LEVEL: z.enum(logLevels).default('info'),

  REDIS_URL: z.url({ message: 'REDIS_URL must be a valid URL' }),

  AI_RUNNER: z.enum(aiRunners).default('direct'),

  NINE_ROUTER_API_KEY: z.string().min(1, 'NINE_ROUTER_API_KEY cannot be empty').optional(),
  NINE_ROUTER_BASE_URL: z
    .url({ message: 'NINE_ROUTER_BASE_URL must be a valid URL' })
    .default('https://api.9router.com/v1'),
  NINE_ROUTER_MODEL: z
    .string()
    .default('opencode'),

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
  if (data.AI_RUNNER === 'direct' && !data.NINE_ROUTER_API_KEY) {
    ctx.addIssue({
      code: 'custom' as const,
      path: ['NINE_ROUTER_API_KEY'],
      message: 'NINE_ROUTER_API_KEY is required when AI_RUNNER=direct',
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

export type AppConfig = z.infer<typeof configSchema>;
