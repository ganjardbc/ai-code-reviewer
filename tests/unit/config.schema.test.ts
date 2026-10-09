import { describe, it, expect } from 'vitest';
import { configSchema } from '../../src/config/schema.js';

const baseEnv = {
  REDIS_URL: 'redis://localhost:6379',
  GITHUB_WEBHOOK_SECRET: 'gh-secret',
  GITHUB_ACCESS_TOKEN: 'gh-token',
  GITLAB_WEBHOOK_SECRET: 'gl-secret',
  GITLAB_ACCESS_TOKEN: 'gl-token',
};

describe('configSchema AI provider keys', () => {
  it('reads OPENAI_* keys', () => {
    const cfg = configSchema.parse({
      ...baseEnv,
      OPENAI_API_KEY: 'new-key',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    });
    expect(cfg.OPENAI_API_KEY).toBe('new-key');
    expect(cfg.OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
    expect(cfg.OPENAI_MODEL).toBe('gpt-4o-mini');
  });

  it('requires OPENAI_BASE_URL when AI_RUNNER=direct instead of guessing an endpoint', () => {
    const result = configSchema.safeParse({ ...baseEnv, OPENAI_API_KEY: 'gateway-key' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual(['OPENAI_BASE_URL']);
  });

  it('does not require OPENAI_* when AI_RUNNER=opencode', () => {
    const cfg = configSchema.parse({ ...baseEnv, AI_RUNNER: 'opencode' });
    expect(cfg.OPENAI_API_KEY).toBeUndefined();
    expect(cfg.OPENAI_BASE_URL).toBeUndefined();
  });

  it('treats empty OPENAI_* values as unset so the legacy fallback still applies', () => {
    const cfg = configSchema.parse({
      ...baseEnv,
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: '',
      OPENAI_MODEL: '',
      NINE_ROUTER_API_KEY: 'old-key',
      NINE_ROUTER_BASE_URL: 'https://gateway.example.com/v1',
    });
    expect(cfg.OPENAI_API_KEY).toBe('old-key');
    expect(cfg.OPENAI_BASE_URL).toBe('https://gateway.example.com/v1');
    expect(cfg.OPENAI_MODEL).toBe('opencode');
  });

  it('falls back to legacy NINE_ROUTER_* keys', () => {
    const cfg = configSchema.parse({
      ...baseEnv,
      NINE_ROUTER_API_KEY: 'old-key',
      NINE_ROUTER_BASE_URL: 'https://gateway.example.com/v1',
      NINE_ROUTER_MODEL: 'old-model',
    });
    expect(cfg.OPENAI_API_KEY).toBe('old-key');
    expect(cfg.OPENAI_BASE_URL).toBe('https://gateway.example.com/v1');
    expect(cfg.OPENAI_MODEL).toBe('old-model');
  });

  it('keeps the old 9Router defaults when only the legacy API key is set', () => {
    const cfg = configSchema.parse({ ...baseEnv, NINE_ROUTER_API_KEY: 'old-key' });
    expect(cfg.OPENAI_BASE_URL).toBe('https://api.9router.com/v1');
    expect(cfg.OPENAI_MODEL).toBe('opencode');
  });

  it('prefers OPENAI_* over legacy keys when both are set', () => {
    const cfg = configSchema.parse({
      ...baseEnv,
      OPENAI_API_KEY: 'new-key',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      NINE_ROUTER_API_KEY: 'old-key',
      NINE_ROUTER_BASE_URL: 'https://gateway.example.com/v1',
    });
    expect(cfg.OPENAI_API_KEY).toBe('new-key');
    expect(cfg.OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
  });

  it('requires OPENAI_API_KEY when AI_RUNNER=direct', () => {
    const result = configSchema.safeParse({ ...baseEnv, AI_RUNNER: 'direct' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('OPENAI_API_KEY is required when AI_RUNNER=direct');
  });
});
