import '../mocks/env.js';
import { describe, it, expect } from 'vitest';
import { getRedisConnectionOptions } from '../../src/infrastructure/queue/connection.js';

describe('getRedisConnectionOptions', () => {
  it('parses host and port with defaults', () => {
    expect(getRedisConnectionOptions('redis://localhost')).toMatchObject({ host: 'localhost', port: 6379 });
  });

  it('keeps ACL username, decoded password and db index', () => {
    const opts = getRedisConnectionOptions('redis://app:p%40ss%3Aword@redis.internal:6380/2');
    expect(opts).toMatchObject({ host: 'redis.internal', port: 6380, username: 'app', password: 'p@ss:word', db: 2 });
    expect(opts.tls).toBeUndefined();
  });

  it('enables TLS for rediss:// URLs', () => {
    expect(getRedisConnectionOptions('rediss://:secret@cache.example.com:6380').tls).toEqual({});
  });
});
