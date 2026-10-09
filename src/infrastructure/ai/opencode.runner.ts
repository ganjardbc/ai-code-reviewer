import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IAiProvider, ReviewResult, FixResult } from '../../domain/interfaces/ai-provider.interface.js';
import type { IOutputParser, IFixOutputParser } from '../../application/services/parser.service.js';
import { AiProviderError } from '../../domain/errors/app-errors.js';
import { logger } from '../logging/logger.js';

// The prompt embeds untrusted PR content, and `opencode run` is an agent with
// tools. Deny every tool so injected instructions can't run commands, read
// files or fetch URLs, and strip this service's own secrets from its env.
// OPENAI_* belong to the direct runner; left in the env they would also make
// opencode pick up an OpenAI provider pointed at that key and endpoint.
const OPENCODE_PERMISSION = JSON.stringify({ '*': 'deny' });
const SECRET_ENV_KEYS = [
  'GITHUB_ACCESS_TOKEN',
  'GITHUB_WEBHOOK_SECRET',
  'GITLAB_ACCESS_TOKEN',
  'GITLAB_WEBHOOK_SECRET',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'NINE_ROUTER_API_KEY',
  'NINE_ROUTER_BASE_URL',
  'TELEGRAM_BOT_TOKEN',
  'REDIS_URL',
];

function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_PERMISSION };
  for (const key of SECRET_ENV_KEYS) delete env[key];
  return env;
}

let sandboxDir: string | undefined;
function getSandboxDir(): string {
  sandboxDir ??= mkdtempSync(join(tmpdir(), 'opencode-sandbox-'));
  return sandboxDir;
}

function extractTextFromEvents(ndjson: string): string {
  const parts: string[] = [];

  for (const line of ndjson.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const part = event['part'] as Record<string, unknown> | undefined;
      if (event['type'] === 'text' && part?.['type'] === 'text' && typeof part['text'] === 'string') {
        parts.push(part['text']);
      }
    } catch { /* skip non-JSON or unknown event lines */ }
  }

  return parts.join('');
}

export class OpenCodeRunner implements IAiProvider {
  constructor(
    private readonly parser: IOutputParser & IFixOutputParser,
    private readonly timeoutMs: number = 120_000,
    private readonly command: string = 'opencode',
  ) {}

  async review(prompt: string): Promise<ReviewResult> {
    logger.info('Sending review request to opencode CLI');

    const raw = await this.execute(prompt);

    logger.debug('Received opencode response', undefined, { length: raw.length });

    return this.parser.parse(raw);
  }

  async fix(prompt: string): Promise<FixResult> {
    logger.info('Sending fix request to opencode CLI');

    const raw = await this.execute(prompt);

    logger.debug('Received opencode fix response', undefined, { length: raw.length });

    return this.parser.parseFix(raw);
  }

  private execute(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;

      // Prompt goes over stdin, not argv: Linux caps a single argv entry at
      // 128KB (MAX_ARG_STRLEN), which full-file fix prompts easily exceed.
      const child = spawn(this.command, ['run', '--format', 'json'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: getSandboxDir(),
        env: buildChildEnv(),
      });

      // Swallow EPIPE if the child exits before reading all of stdin; the
      // 'close' handler reports the real failure.
      child.stdin.on('error', () => undefined);
      child.stdin.end(prompt);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new AiProviderError(`opencode timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (code !== 0) {
          reject(new AiProviderError(`opencode exited with code ${code ?? 'null'}: ${stderr.slice(0, 500)}`));
          return;
        }

        resolve(extractTextFromEvents(stdout));
      });

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new AiProviderError(`opencode spawn error: ${err.message}`));
      });
    });
  }
}
