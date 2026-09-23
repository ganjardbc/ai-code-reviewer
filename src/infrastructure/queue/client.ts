import { Queue } from 'bullmq';
import type { AddJobOptions, IQueue } from '../../domain/interfaces/queue.interface.js';
import { config } from '../../config/index.js';
import { getRedisConnectionOptions } from './connection.js';
import { logger } from '../logging/logger.js';

export const QUEUE_NAME = 'review';

const defaultJobOptions = {
  removeOnComplete: {
    age: config.QUEUE_JOB_TTL_SECONDS,
    count: config.QUEUE_MAX_JOBS_RETAINED,
  },
  removeOnFail: {
    age: config.QUEUE_JOB_TTL_SECONDS,
    count: config.QUEUE_MAX_JOBS_RETAINED,
  },
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
};

class ReviewQueue implements IQueue {
  private readonly queue: Queue;

  constructor() {
    this.queue = new Queue(QUEUE_NAME, {
      connection: getRedisConnectionOptions(),
      defaultJobOptions,
    });

    this.queue.on('error', (err: Error) => {
      logger.error('Queue error', err);
    });
  }

  async addJob(name: string, data: Record<string, unknown>, options: AddJobOptions = {}): Promise<string> {
    const job = await this.queue.add(name, data, options.jobId ? { jobId: options.jobId } : undefined);
    const id = job.id ?? 'unknown';
    logger.info('Job enqueued', undefined, { jobId: id, name });
    return id;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export const reviewQueue: IQueue = new ReviewQueue();
