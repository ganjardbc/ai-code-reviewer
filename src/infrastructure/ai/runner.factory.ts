import type { IAiProvider } from '../../domain/interfaces/ai-provider.interface.js';
import type { IOutputParser, IFixOutputParser } from '../../application/services/parser.service.js';
import type { AppConfig } from '../../config/schema.js';
import { config as globalConfig } from '../../config/index.js';
import { DirectApiRunner } from './direct-api.runner.js';
import { OpenCodeRunner } from './opencode.runner.js';

type RunnerConfig = Pick<
  AppConfig,
  'AI_RUNNER' | 'OPENAI_API_KEY' | 'OPENCODE_TIMEOUT_MS' | 'OPENCODE_COMMAND'
>;

export function createRunner(parser: IOutputParser & IFixOutputParser, cfg: RunnerConfig = globalConfig): IAiProvider {
  if (cfg.AI_RUNNER === 'opencode') {
    return new OpenCodeRunner(parser, cfg.OPENCODE_TIMEOUT_MS, cfg.OPENCODE_COMMAND);
  }

  if (!cfg.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when AI_RUNNER=direct');
  }

  return new DirectApiRunner(parser);
}
