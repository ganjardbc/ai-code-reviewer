import '../mocks/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Processor = (job: unknown) => Promise<void>;
const captured: { processor?: Processor } = {};

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>();
  return {
    ...actual,
    Worker: class {
      constructor(_name: string, processor: Processor) {
        captured.processor = processor;
      }
      on(): void {}
      close = vi.fn();
    },
  };
});

vi.mock('../../src/infrastructure/queue/connection.js', () => ({
  getRedisConnectionOptions: vi.fn(() => ({})),
}));

const { UnrecoverableError } = await import('bullmq');
const { QueueWorker } = await import('../../src/infrastructure/queue/worker.js');
const { ValidationError, GitError } = await import('../../src/domain/errors/app-errors.js');

function fakeJob(attemptsMade: number, attempts = 3) {
  return { id: 'j1', name: 'github-review', data: { jobId: 'j1' }, attemptsMade, opts: { attempts }, timestamp: Date.now() };
}

describe('QueueWorker', () => {
  const runner = vi.fn();

  beforeEach(() => {
    runner.mockReset().mockResolvedValue(undefined);
    new QueueWorker(runner);
  });

  it('flags only the last configured attempt as final', async () => {
    await captured.processor!(fakeJob(0));
    await captured.processor!(fakeJob(2));

    expect(runner.mock.calls[0]?.[0]).toMatchObject({ isFinalAttempt: false });
    expect(runner.mock.calls[1]?.[0]).toMatchObject({ isFinalAttempt: true });
  });

  it('converts permanent errors into UnrecoverableError so BullMQ stops retrying', async () => {
    runner.mockRejectedValue(new ValidationError('Invalid commit SHA'));

    await expect(captured.processor!(fakeJob(0))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('rethrows transient errors unchanged so BullMQ retries them', async () => {
    const err = new GitError('network down');
    runner.mockRejectedValue(err);

    await expect(captured.processor!(fakeJob(0))).rejects.toBe(err);
  });
});
