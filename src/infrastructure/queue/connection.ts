import { Redis as IORedis } from 'ioredis';
import { config } from '../../config/index.js';
import { logger } from '../logging/logger.js';

export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
  enableReadyCheck: boolean;
}

export function getRedisConnectionOptions(redisUrl: string = config.REDIS_URL): RedisConnectionOptions {
  const url = new URL(redisUrl);
  const db = parseInt(url.pathname.slice(1), 10);
  return {
    host: url.hostname,
    port: parseInt(url.port, 10) || 6379,
    // ACL users (Redis 6+) and managed Redis need the username; percent-
    // decoding matters for passwords containing reserved URL characters.
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number.isNaN(db) ? undefined : db,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

let client: IORedis | null = null;

export function getRedisClient(): IORedis {
  if (!client) {
    client = new IORedis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    client.on('error', (err: Error) => {
      logger.error('Redis client error', err);
    });

    client.on('connect', () => {
      logger.info('Redis connected');
    });

    client.on('reconnecting', () => {
      logger.warn('Redis reconnecting');
    });
  }

  return client;
}

export async function closeRedisConnection(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
