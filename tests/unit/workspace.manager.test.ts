import '../mocks/env.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceManager, STALE_WORKSPACE_AGE_MS } from '../../src/infrastructure/git/workspace.manager.js';

const WORKSPACE_ROOT = '/tmp/ai-reviewer-test';

describe('WorkspaceManager.sweepStaleWorkspaces', () => {
  const manager = new WorkspaceManager();
  let created: string[];

  function makeDir(name: string, ageMs: number): string {
    const dir = join(WORKSPACE_ROOT, name);
    mkdirSync(join(dir, 'repo'), { recursive: true });
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(dir, t, t);
    created.push(dir);
    return dir;
  }

  beforeEach(() => {
    created = [];
  });

  afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });

  it('removes only job workspaces older than the cutoff', async () => {
    const stale = makeDir(`job-${randomUUID()}`, STALE_WORKSPACE_AGE_MS + 60_000);
    const fresh = makeDir(`job-${randomUUID()}`, 60_000);
    const unrelated = makeDir(`origin-${randomUUID()}`, STALE_WORKSPACE_AGE_MS * 2);

    const removed = await manager.sweepStaleWorkspaces();

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });
});
