import '../mocks/env.js';
import { describe, it, expect } from 'vitest';
import { DirectApiRunner } from '../../src/infrastructure/ai/direct-api.runner.js';
import { OpenAiCompatibleService } from '../../src/infrastructure/ai/openai-compatible.service.js';

describe('DirectApiRunner', () => {
  it('is the OpenAiCompatibleService implementation', () => {
    expect(DirectApiRunner).toBe(OpenAiCompatibleService);
  });

  it('implements IAiProvider interface', () => {
    const parser = { parse: () => ({ comments: [] }) };
    const runner = new DirectApiRunner(parser);
    expect(typeof runner.review).toBe('function');
  });
});
