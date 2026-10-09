import '../mocks/env.js';
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'child_process';
import { OpenCodeRunner } from '../../src/infrastructure/ai/opencode.runner.js';
import { ParserService } from '../../src/application/services/parser.service.js';
import { AiProviderError } from '../../src/domain/errors/app-errors.js';

const mockedSpawn = spawn as MockedFunction<typeof spawn>;

function ndjsonEvent(text: string): string {
  return JSON.stringify({ type: 'text', part: { type: 'text', text } });
}

function makeMockChild(opts?: { exitCode?: number | null; stdout?: string; stderr?: string; spawnError?: Error }) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { end: (data?: string) => void };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (signal?: string) => boolean;
  };

  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn().mockReturnValue(true);

  setImmediate(() => {
    if (opts?.spawnError) {
      child.emit('error', opts.spawnError);
      return;
    }
    if (opts?.stdout) {
      child.stdout.emit('data', Buffer.from(opts.stdout));
    }
    if (opts?.stderr) {
      child.stderr.emit('data', Buffer.from(opts.stderr));
    }
    child.emit('close', opts?.exitCode ?? 0);
  });

  return child;
}

const VALID_COMMENT = { filePath: 'src/a.ts', lineNumber: 1, message: 'ok', severity: 'INFO' };
const VALID_JSON = JSON.stringify({ comments: [VALID_COMMENT] });

describe('OpenCodeRunner', () => {
  const parser = new ParserService();

  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  it('extracts text from NDJSON events and parses result', async () => {
    const events = ndjsonEvent(VALID_JSON);
    mockedSpawn.mockReturnValue(makeMockChild({ stdout: events }) as ReturnType<typeof spawn>);

    const runner = new OpenCodeRunner(parser);
    const result = await runner.review('prompt');

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.filePath).toBe('src/a.ts');
  });

  it('concatenates multiple text events', async () => {
    const half = VALID_JSON.slice(0, Math.floor(VALID_JSON.length / 2));
    const rest = VALID_JSON.slice(Math.floor(VALID_JSON.length / 2));
    const events = [ndjsonEvent(half), ndjsonEvent(rest)].join('\n');
    mockedSpawn.mockReturnValue(makeMockChild({ stdout: events }) as ReturnType<typeof spawn>);

    const runner = new OpenCodeRunner(parser);
    const result = await runner.review('prompt');
    expect(result.comments).toHaveLength(1);
  });

  it('ignores unknown event types', async () => {
    const events = [
      JSON.stringify({ type: 'step_start', part: {} }),
      ndjsonEvent(VALID_JSON),
      JSON.stringify({ type: 'step_finish', part: {} }),
    ].join('\n');
    mockedSpawn.mockReturnValue(makeMockChild({ stdout: events }) as ReturnType<typeof spawn>);

    const runner = new OpenCodeRunner(parser);
    const result = await runner.review('prompt');
    expect(result.comments).toHaveLength(1);
  });

  it('throws AiProviderError on non-zero exit code', async () => {
    mockedSpawn.mockReturnValue(
      makeMockChild({ exitCode: 1, stderr: 'opencode failed' }) as ReturnType<typeof spawn>,
    );

    const runner = new OpenCodeRunner(parser);
    const err = await runner.review('prompt').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as Error).message).toMatch(/exited with code 1/);
  });

  it('throws AiProviderError on spawn error', async () => {
    mockedSpawn.mockReturnValue(
      makeMockChild({ spawnError: new Error('ENOENT') }) as ReturnType<typeof spawn>,
    );

    const runner = new OpenCodeRunner(parser);
    const err = await runner.review('prompt').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as Error).message).toMatch(/spawn error/);
  });

  it('throws AiProviderError on timeout', async () => {
    vi.useFakeTimers();

    const child = new EventEmitter() as EventEmitter & {
      stdin: EventEmitter & { end: (data?: string) => void };
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (signal?: string) => boolean;
    };
    child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn().mockReturnValue(true);

    mockedSpawn.mockReturnValue(child as ReturnType<typeof spawn>);

    const runner = new OpenCodeRunner(parser, 1_000);
    const promise = runner.review('prompt');

    vi.advanceTimersByTime(1_001);

    await expect(promise).rejects.toThrow(/timed out after 1000ms/);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    vi.useRealTimers();
  });

  it('returns empty comments when stdout has no text events', async () => {
    mockedSpawn.mockReturnValue(makeMockChild({ stdout: '' }) as ReturnType<typeof spawn>);

    const runner = new OpenCodeRunner(parser);
    const result = await runner.review('prompt');
    expect(result.comments).toHaveLength(0);
  });

  it('invokes configured command with run subcommand', async () => {
    mockedSpawn.mockReturnValue(makeMockChild({ stdout: ndjsonEvent(VALID_JSON) }) as ReturnType<typeof spawn>);

    const runner = new OpenCodeRunner(parser, 120_000, 'my-opencode');
    await runner.review('my prompt');

    expect(mockedSpawn).toHaveBeenCalledWith(
      'my-opencode',
      ['run', '--format', 'json'],
      expect.any(Object),
    );
  });

  it('sends the prompt over stdin instead of argv', async () => {
    const child = makeMockChild({ stdout: ndjsonEvent(VALID_JSON) });
    mockedSpawn.mockReturnValue(child as ReturnType<typeof spawn>);

    const runner = new OpenCodeRunner(parser);
    await runner.review('my prompt');

    expect(child.stdin.end).toHaveBeenCalledWith('my prompt');
  });

  it('denies all opencode tools and strips service secrets from the child env', async () => {
    mockedSpawn.mockReturnValue(makeMockChild({ stdout: ndjsonEvent(VALID_JSON) }) as ReturnType<typeof spawn>);

    const runner = new OpenCodeRunner(parser);
    await runner.review('prompt');

    const options = mockedSpawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv; cwd: string };
    expect(JSON.parse(options.env['OPENCODE_PERMISSION']!)).toEqual({ '*': 'deny' });
    expect(options.env['GITHUB_ACCESS_TOKEN']).toBeUndefined();
    expect(options.env['GITLAB_ACCESS_TOKEN']).toBeUndefined();
    expect(options.env['OPENAI_API_KEY']).toBeUndefined();
    expect(options.env['OPENAI_BASE_URL']).toBeUndefined();
    expect(options.cwd).toContain('opencode-sandbox-');
  });
});
