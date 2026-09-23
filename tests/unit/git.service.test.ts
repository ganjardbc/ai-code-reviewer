import '../mocks/env.js';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../src/infrastructure/git/git.service.js';

const WORKSPACE_ROOT = '/tmp/ai-reviewer-test';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function initBareOrigin(originPath: string): void {
  mkdirSync(originPath, { recursive: true });
  git(['init', '--bare', '--initial-branch=main'], originPath);
}

function seedOrigin(originPath: string): void {
  const seedDir = `${originPath}-seed`;
  mkdirSync(seedDir, { recursive: true });
  git(['init', '--initial-branch=main'], seedDir);
  writeFileSync(join(seedDir, 'file.txt'), 'hello\n');
  git(['add', '-A'], seedDir);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-m', 'init'], seedDir);
  git(['remote', 'add', 'origin', originPath], seedDir);
  git(['push', 'origin', 'main'], seedDir);
  rmSync(seedDir, { recursive: true, force: true });
}

describe('GitService.commitAll / push', () => {
  let originPath: string;
  let targetDir: string;
  const gitService = new GitService();

  beforeEach(async () => {
    const suffix = Math.random().toString(36).slice(2);
    originPath = join(WORKSPACE_ROOT, `origin-${suffix}.git`);
    targetDir = join(WORKSPACE_ROOT, `clone-${suffix}`);

    initBareOrigin(originPath);
    seedOrigin(originPath);

    await gitService.clone(originPath, 'main', targetDir);
  });

  afterEach(() => {
    rmSync(originPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it('returns false from commitAll when there are no changes', async () => {
    const committed = await gitService.commitAll(targetDir, 'no-op');
    expect(committed).toBe(false);
  });

  it('commits and pushes local changes to the origin', async () => {
    writeFileSync(join(targetDir, 'file.txt'), 'updated content\n');

    const committed = await gitService.commitAll(targetDir, 'fix: update file');
    expect(committed).toBe(true);

    await gitService.push(targetDir, originPath, 'main');

    const log = execFileSync('git', ['log', '--oneline', 'main'], { cwd: originPath }).toString();
    expect(log).toContain('fix: update file');
  });

  it('rejects paths outside the workspace root', async () => {
    await expect(gitService.commitAll('/tmp/outside-workspace', 'msg')).rejects.toThrow();
    await expect(gitService.push('/tmp/outside-workspace', originPath, 'main')).rejects.toThrow();
  });

  it('rebases and retries when the remote branch has moved with a non-conflicting change', async () => {
    const otherDir = `${targetDir}-other`;
    await gitService.clone(originPath, 'main', otherDir);
    writeFileSync(join(otherDir, 'other.txt'), 'other change\n');
    await gitService.commitAll(otherDir, 'other: unrelated change');
    await gitService.push(otherDir, originPath, 'main');
    rmSync(otherDir, { recursive: true, force: true });

    writeFileSync(join(targetDir, 'file.txt'), 'my change\n');
    await gitService.commitAll(targetDir, 'fix: my change');

    await gitService.push(targetDir, originPath, 'main');

    const log = execFileSync('git', ['log', '--oneline', 'main'], { cwd: originPath }).toString();
    expect(log).toContain('fix: my change');
    expect(log).toContain('other: unrelated change');
  });

  it('throws a clear error when the rebase hits a real conflict', async () => {
    const otherDir = `${targetDir}-conflict`;
    await gitService.clone(originPath, 'main', otherDir);
    writeFileSync(join(otherDir, 'file.txt'), 'conflicting remote change\n');
    await gitService.commitAll(otherDir, 'other: conflicting change');
    await gitService.push(otherDir, originPath, 'main');
    rmSync(otherDir, { recursive: true, force: true });

    writeFileSync(join(targetDir, 'file.txt'), 'conflicting local change\n');
    await gitService.commitAll(targetDir, 'fix: conflicting change');

    await expect(gitService.push(targetDir, originPath, 'main')).rejects.toThrow(/conflict/i);
  });

  it('does not retry a policy rejection (e.g. protected branch) as if it were a non-fast-forward', async () => {
    const counterFile = `${originPath}-hook-calls`;
    writeFileSync(counterFile, '');

    const hookPath = join(originPath, 'hooks', 'pre-receive');
    writeFileSync(
      hookPath,
      `#!/bin/sh\necho x >> "${counterFile}"\necho "remote rejected: protected branch hook declined" >&2\nexit 1\n`,
    );
    chmodSync(hookPath, 0o755);

    writeFileSync(join(targetDir, 'file.txt'), 'my change\n');
    await gitService.commitAll(targetDir, 'fix: my change');

    await expect(gitService.push(targetDir, originPath, 'main')).rejects.toThrow();

    const callCount = readFileSync(counterFile, 'utf-8').trim().split('\n').filter(Boolean).length;
    expect(callCount).toBe(1);

    rmSync(counterFile, { force: true });
  });
});

describe('GitService.generateDiff', () => {
  let originPath: string;
  let targetDir: string;
  const gitService = new GitService();

  afterEach(() => {
    rmSync(originPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it('diffs the checked-out commit, not the head branch tip it was cloned at', async () => {
    const suffix = Math.random().toString(36).slice(2);
    originPath = join(WORKSPACE_ROOT, `origin-${suffix}.git`);
    targetDir = join(WORKSPACE_ROOT, `clone-${suffix}`);
    initBareOrigin(originPath);
    seedOrigin(originPath);

    // Push two commits to `feature`; the webhook only knew about the first.
    const seedDir = `${originPath}-feature`;
    git(['clone', originPath, seedDir], WORKSPACE_ROOT);
    git(['checkout', '-b', 'feature'], seedDir);
    writeFileSync(join(seedDir, 'file.txt'), 'hello\nfirst\n');
    git(['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-am', 'first'], seedDir);
    const webhookSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: seedDir }).toString().trim();
    writeFileSync(join(seedDir, 'file.txt'), 'hello\nfirst\nsecond\n');
    git(['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-am', 'second'], seedDir);
    git(['push', 'origin', 'feature'], seedDir);
    rmSync(seedDir, { recursive: true, force: true });

    await gitService.clone(originPath, 'feature', targetDir);
    await gitService.checkout(targetDir, webhookSha);
    const diff = await gitService.generateDiff(targetDir, 'main');

    expect(diff).toContain('+first');
    expect(diff).not.toContain('+second');
  });
});

describe('GitService.fetchRef', () => {
  let originPath: string;
  let targetDir: string;
  const gitService = new GitService();

  afterEach(() => {
    rmSync(originPath, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it('checks out a PR head that only exists as refs/pull/N/head (fork PR)', async () => {
    const suffix = Math.random().toString(36).slice(2);
    originPath = join(WORKSPACE_ROOT, `origin-${suffix}.git`);
    targetDir = join(WORKSPACE_ROOT, `clone-${suffix}`);
    initBareOrigin(originPath);
    seedOrigin(originPath);

    // Simulate GitHub: the fork's commit is reachable from the base repo only via refs/pull/7/head.
    const forkDir = `${originPath}-fork`;
    git(['clone', originPath, forkDir], WORKSPACE_ROOT);
    writeFileSync(join(forkDir, 'file.txt'), 'hello\nfrom fork\n');
    git(['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-am', 'fork change'], forkDir);
    const forkSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: forkDir }).toString().trim();
    git(['push', 'origin', 'HEAD:refs/pull/7/head'], forkDir);
    rmSync(forkDir, { recursive: true, force: true });

    await gitService.clone(originPath, 'main', targetDir);
    await gitService.fetchRef(targetDir, 'refs/pull/7/head');
    await gitService.checkout(targetDir, forkSha);
    const diff = await gitService.generateDiff(targetDir, 'main');

    expect(diff).toContain('+from fork');
  });

  it('rejects refs that are not plain refs/ paths', async () => {
    targetDir = join(WORKSPACE_ROOT, 'clone-unused');
    originPath = join(WORKSPACE_ROOT, 'origin-unused');
    await expect(gitService.fetchRef(targetDir, '--upload-pack=evil')).rejects.toThrow(/Invalid ref/);
    await expect(gitService.fetchRef(targetDir, 'refs/../../etc')).rejects.toThrow(/Invalid ref/);
  });
});

describe('GitService credentials', () => {
  let server: Server;
  let baseUrl: string;
  let authHeaders: Array<string | undefined>;
  const gitService = new GitService();

  beforeEach(async () => {
    authHeaders = [];
    server = createServer((req, res) => {
      authHeaders.push(req.headers.authorization);
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('sends the token as a Basic auth header without putting it in the URL', async () => {
    const targetDir = join(WORKSPACE_ROOT, `clone-auth-${Math.random().toString(36).slice(2)}`);

    await expect(
      gitService.clone(`${baseUrl}/org/repo.git`, 'main', targetDir, { username: 'x-access-token', token: 's3cret' }),
    ).rejects.toThrow();

    const expected = `Basic ${Buffer.from('x-access-token:s3cret').toString('base64')}`;
    expect(authHeaders).toContain(expected);
    rmSync(targetDir, { recursive: true, force: true });
  });

  it('redacts credentials embedded in a URL from git error messages', async () => {
    const targetDir = join(WORKSPACE_ROOT, `clone-redact-${Math.random().toString(36).slice(2)}`);
    const withCreds = baseUrl.replace('http://', 'http://oauth2:leaky-token@');

    const err = await gitService.clone(`${withCreds}/org/repo.git`, 'main', targetDir).catch((e: unknown) => e);

    expect((err as Error).message).not.toContain('leaky-token');
    rmSync(targetDir, { recursive: true, force: true });
  });
});
