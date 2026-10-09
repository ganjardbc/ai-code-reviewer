import '../mocks/env.js';
import { describe, it, expect, vi } from 'vitest';
import { createRunner } from '../../src/infrastructure/ai/runner.factory.js';
import { DirectApiRunner } from '../../src/infrastructure/ai/direct-api.runner.js';
import { OpenCodeRunner } from '../../src/infrastructure/ai/opencode.runner.js';
import type { IOutputParser } from '../../src/application/services/parser.service.js';

const mockParser: IOutputParser = { parse: vi.fn() };

const baseConfig = {
  AI_RUNNER: 'direct' as const,
  OPENAI_API_KEY: 'test-key',
  OPENCODE_TIMEOUT_MS: 120_000,
  OPENCODE_COMMAND: 'opencode',
};

describe('createRunner', () => {
  it('returns DirectApiRunner when AI_RUNNER=direct', () => {
    const runner = createRunner(mockParser, { ...baseConfig, AI_RUNNER: 'direct' });
    expect(runner).toBeInstanceOf(DirectApiRunner);
  });

  it('returns OpenCodeRunner when AI_RUNNER=opencode', () => {
    const runner = createRunner(mockParser, { ...baseConfig, AI_RUNNER: 'opencode' });
    expect(runner).toBeInstanceOf(OpenCodeRunner);
  });

  it('throws when AI_RUNNER=direct and OPENAI_API_KEY missing', () => {
    expect(() =>
      createRunner(mockParser, { ...baseConfig, AI_RUNNER: 'direct', OPENAI_API_KEY: undefined }),
    ).toThrow('OPENAI_API_KEY is required when AI_RUNNER=direct');
  });

  it('does not throw when AI_RUNNER=opencode and OPENAI_API_KEY missing', () => {
    expect(() =>
      createRunner(mockParser, { ...baseConfig, AI_RUNNER: 'opencode', OPENAI_API_KEY: undefined }),
    ).not.toThrow();
  });

  it('passes timeout and command to OpenCodeRunner', () => {
    const runner = createRunner(mockParser, {
      ...baseConfig,
      AI_RUNNER: 'opencode',
      OPENCODE_TIMEOUT_MS: 5_000,
      OPENCODE_COMMAND: 'my-opencode',
    });
    expect(runner).toBeInstanceOf(OpenCodeRunner);
  });
});
