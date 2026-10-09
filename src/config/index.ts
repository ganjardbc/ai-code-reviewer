import 'dotenv/config';
import { configSchema, LEGACY_AI_ENV_KEYS, type AppConfig } from './schema.js';

function loadConfig(): Readonly<AppConfig> {
  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${issues}`);
  }

  for (const [legacy, current] of Object.entries(LEGACY_AI_ENV_KEYS)) {
    if (process.env[legacy]) {
      process.emitWarning(`${legacy} is deprecated; use ${current} instead`, 'DeprecationWarning');
    }
  }

  return Object.freeze(result.data);
}

export const config: Readonly<AppConfig> = loadConfig();
export type { AppConfig };
