import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { remove } from 'fs-extra';
import type { IWorkspaceManager } from '../../domain/interfaces/git.interface.js';
import { config } from '../../config/index.js';
import { ValidationError } from '../../domain/errors/app-errors.js';
import { logger } from '../logging/logger.js';

const WORKSPACE_ROOT = resolve(config.WORKSPACE_DIR);
const JOB_DIR_PATTERN = /^job-[0-9a-f-]{36}$/;
// Far longer than any job can run, so a sweep never races a live job on
// another worker that shares the same workspace volume.
export const STALE_WORKSPACE_AGE_MS = 6 * 60 * 60 * 1000;

export class WorkspaceManager implements IWorkspaceManager {
  validatePath(dirPath: string): boolean {
    const resolved = resolve(dirPath);
    return resolved.startsWith(WORKSPACE_ROOT + '/') || resolved === WORKSPACE_ROOT;
  }

  async createWorkspace(): Promise<string> {
    const workspacePath = join(WORKSPACE_ROOT, `job-${randomUUID()}`);
    mkdirSync(workspacePath, { recursive: true });
    logger.debug('Workspace created', undefined, { path: workspacePath });
    return workspacePath;
  }

  /**
   * Removes job workspaces left behind when a worker died mid-job (OOM,
   * SIGKILL) and never reached its `finally` cleanup. Returns the count removed.
   */
  async sweepStaleWorkspaces(maxAgeMs: number = STALE_WORKSPACE_AGE_MS, now: number = Date.now()): Promise<number> {
    let entries;
    try {
      entries = await readdir(WORKSPACE_ROOT, { withFileTypes: true });
    } catch {
      return 0; // workspace root not created yet
    }

    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !JOB_DIR_PATTERN.test(entry.name)) continue;
      const dirPath = join(WORKSPACE_ROOT, entry.name);
      try {
        const { mtimeMs } = await stat(dirPath);
        if (now - mtimeMs < maxAgeMs) continue;
        await this.cleanupWorkspace(dirPath);
        removed++;
      } catch (err) {
        logger.warn('Failed to sweep stale workspace', undefined, {
          path: dirPath,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (removed > 0) logger.info('Swept stale workspaces', undefined, { removed });
    return removed;
  }

  async cleanupWorkspace(dirPath: string): Promise<void> {
    if (!this.validatePath(dirPath)) {
      throw new ValidationError(`Workspace path escape attempt detected: ${dirPath}`);
    }
    await remove(dirPath);
    logger.debug('Workspace removed', undefined, { path: dirPath });
  }
}
