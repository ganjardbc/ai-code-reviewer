import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { GitAuth, IGitService } from '../../domain/interfaces/git.interface.js';
import { config } from '../../config/index.js';
import { GitError, ValidationError } from '../../domain/errors/app-errors.js';
import { logger } from '../logging/logger.js';

const WORKSPACE_ROOT = resolve(config.WORKSPACE_DIR);
const CLONE_DEPTH = 50;

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
};

function assertInsideWorkspace(dirPath: string): void {
  const resolved = resolve(dirPath);
  if (!resolved.startsWith(WORKSPACE_ROOT + '/') && resolved !== WORKSPACE_ROOT) {
    throw new ValidationError(`Path escape attempt detected: ${dirPath}`);
  }
}

const SAFE_REF_PATTERN = /^refs\/[A-Za-z0-9._\/-]+$/;
const HEAD_TRACKING_REF = 'refs/remotes/origin/pr-head';

// Scrubs `scheme://user:pass@` from git output before it lands in errors,
// logs or Telegram — covers jobs enqueued before tokens left the URL.
function redactUrlCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
}

/**
 * Supplies credentials through GIT_CONFIG_{COUNT,KEY_n,VALUE_n} (git >= 2.31)
 * rather than the URL or `-c` flags, so the token stays out of argv (visible
 * in `ps`), `.git/config`, and git's own error messages. The header is scoped
 * to the remote's origin so it is never sent to any other host.
 */
function authEnv(remoteUrl: string, auth: GitAuth | undefined): NodeJS.ProcessEnv {
  if (!auth) return {};
  let scope: string;
  try {
    const url = new URL(remoteUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return {};
    scope = `${url.protocol}//${url.host}/`;
  } catch {
    return {};
  }
  const basic = Buffer.from(`${auth.username}:${auth.token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${scope}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

function redactCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function isNonFastForwardError(err: unknown): boolean {
  // Deliberately excludes the generic "rejected" substring: branch-protection
  // and pre-receive-hook denials also say "[remote rejected] ... declined"
  // but aren't a real conflict, so retrying via rebase would be pointless.
  return err instanceof GitError && /non-fast-forward|fetch first/i.test(err.message);
}

async function originAuthEnv(targetDir: string, auth: GitAuth | undefined): Promise<NodeJS.ProcessEnv> {
  if (!auth) return {};
  const originUrl = (await runGit(['remote', 'get-url', 'origin'], targetDir)).trim();
  return authEnv(originUrl, auth);
}

async function ensureFullHistory(targetDir: string, auth?: GitAuth): Promise<void> {
  const isShallow = (await runGit(['rev-parse', '--is-shallow-repository'], targetDir)).trim();
  if (isShallow === 'true') {
    await runGit(['fetch', '--unshallow', 'origin'], targetDir, await originAuthEnv(targetDir, auth));
  }
}

function runGit(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      env: { ...GIT_ENV, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: config.GIT_TIMEOUT_MS,
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => err.push(chunk));

    proc.on('close', (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf-8'));
      } else {
        const msg = redactUrlCredentials(Buffer.concat(err).toString('utf-8').trim());
        reject(new GitError(`git ${args[0]} failed (${code ?? signal}): ${msg}`));
      }
    });

    proc.on('error', (spawnErr) => {
      reject(new GitError(`git spawn error: ${spawnErr.message}`));
    });
  });
}

export class GitService implements IGitService {
  async clone(repoUrl: string, branch: string, targetDir: string, auth?: GitAuth): Promise<void> {
    assertInsideWorkspace(targetDir);

    logger.info('Cloning repository', undefined, { repoUrl: redactCredentials(repoUrl), branch });

    await runGit(
      [
        'clone',
        '--depth', String(CLONE_DEPTH),
        '--single-branch',
        '--branch', branch,
        '--',
        repoUrl,
        targetDir,
      ],
      WORKSPACE_ROOT,
      authEnv(repoUrl, auth),
    );

    logger.debug('Clone complete', undefined, { targetDir });
  }

  async fetchRef(targetDir: string, ref: string, auth?: GitAuth): Promise<void> {
    assertInsideWorkspace(targetDir);

    if (!SAFE_REF_PATTERN.test(ref) || ref.includes('..')) {
      throw new ValidationError(`Invalid ref: ${ref}`);
    }

    // Registering the refspec (not just fetching it once) makes a later
    // `fetch --unshallow origin` deepen this ref's history too.
    const refspec = `+${ref}:${HEAD_TRACKING_REF}`;
    await runGit(['config', '--add', 'remote.origin.fetch', refspec], targetDir);

    logger.debug('Fetching ref', undefined, { ref });
    await runGit(
      ['fetch', `--depth=${CLONE_DEPTH}`, 'origin', refspec],
      targetDir,
      await originAuthEnv(targetDir, auth),
    );
  }

  async checkout(targetDir: string, commitSha: string): Promise<void> {
    assertInsideWorkspace(targetDir);

    if (!/^[0-9a-f]{7,40}$/i.test(commitSha)) {
      throw new ValidationError(`Invalid commit SHA: ${commitSha}`);
    }

    logger.debug('Checking out commit', undefined, { commitSha });
    await runGit(['checkout', '--detach', commitSha], targetDir);
  }

  async generateDiff(targetDir: string, baseBranch: string, auth?: GitAuth): Promise<string> {
    // Diffs against HEAD (the checked-out job.headSha), never the head branch
    // name: the branch may have advanced since the webhook fired, and review
    // comments are anchored to headSha, so line numbers must come from it.
    assertInsideWorkspace(targetDir);

    logger.debug('Fetching base branch for diff', undefined, { baseBranch });

    // Explicit refspec: --single-branch clones don't track other branches,
    // and `remote set-branches` would drop the refspec fetchRef registered.
    const env = await originAuthEnv(targetDir, auth);
    await runGit(
      ['fetch', `--depth=${CLONE_DEPTH}`, 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
      targetDir,
      env,
    );

    try {
      return await runGit(
        ['diff', `origin/${baseBranch}...HEAD`, '--', '.'],
        targetDir,
      );
    } catch (err) {
      // Shallow history (CLONE_DEPTH) can leave head/base without a common
      // ancestor for branches that diverged further back. Deepen to full
      // history and retry once rather than failing or producing a bad diff.
      logger.warn('Diff failed at shallow depth, retrying with full history', undefined, { baseBranch });
      await ensureFullHistory(targetDir, auth);
      return runGit(
        ['diff', `origin/${baseBranch}...HEAD`, '--', '.'],
        targetDir,
      ).catch(() => {
        throw err;
      });
    }
  }

  async commitAll(targetDir: string, message: string): Promise<boolean> {
    assertInsideWorkspace(targetDir);

    await runGit(['add', '-A'], targetDir);

    const status = await runGit(['status', '--porcelain'], targetDir);
    if (!status.trim()) {
      logger.info('No changes to commit', undefined, { targetDir });
      return false;
    }

    await runGit(
      [
        '-c', 'user.name=ai-code-review-bot',
        '-c', 'user.email=ai-code-review-bot@users.noreply.github.com',
        'commit',
        '-m', message,
      ],
      targetDir,
    );

    logger.info('Committed fix changes', undefined, { targetDir });
    return true;
  }

  async push(targetDir: string, remoteUrl: string, branch: string, auth?: GitAuth): Promise<void> {
    assertInsideWorkspace(targetDir);
    const env = authEnv(remoteUrl, auth);

    try {
      await this.attemptPush(targetDir, remoteUrl, branch, env);
    } catch (err) {
      if (!isNonFastForwardError(err)) {
        throw err;
      }

      logger.warn('Push rejected — branch moved since clone, rebasing onto latest remote commit', undefined, { branch });
      await ensureFullHistory(targetDir, auth);
      await runGit(['fetch', '--', remoteUrl, branch], targetDir, env);

      try {
        await runGit(['rebase', 'FETCH_HEAD'], targetDir);
      } catch (rebaseErr) {
        await runGit(['rebase', '--abort'], targetDir).catch(() => undefined);
        const msg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
        throw new GitError(`Push rejected and rebase onto latest ${branch} failed, likely a real conflict: ${msg}`);
      }

      await this.attemptPush(targetDir, remoteUrl, branch, env);
    }
  }

  private async attemptPush(targetDir: string, remoteUrl: string, branch: string, env: NodeJS.ProcessEnv): Promise<void> {
    logger.info('Pushing fix commit', undefined, { branch });
    await runGit(['push', '--', remoteUrl, `HEAD:refs/heads/${branch}`], targetDir, env);
  }
}
