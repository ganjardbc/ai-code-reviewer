import '../mocks/env.js';
import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  verifyGithubSignature,
  verifyGitlabToken,
  isSafeBranchName,
} from '../../src/infrastructure/vcs/security.js';

const SECRET = 'github-test-secret';

function makeSignature(body: string, secret = SECRET): string {
  const hex = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
  return `sha256=${hex}`;
}

describe('verifyGithubSignature', () => {
  it('accepts valid signature', () => {
    const body = Buffer.from('{"action":"opened"}');
    const sig = makeSignature(body.toString());
    expect(verifyGithubSignature(body, sig, SECRET)).toBe(true);
  });

  it('rejects wrong secret', () => {
    const body = Buffer.from('{"action":"opened"}');
    const sig = makeSignature(body.toString(), 'wrong-secret');
    expect(verifyGithubSignature(body, sig, SECRET)).toBe(false);
  });

  it('rejects missing header', () => {
    const body = Buffer.from('{"action":"opened"}');
    expect(verifyGithubSignature(body, undefined, SECRET)).toBe(false);
  });

  it('rejects tampered body', () => {
    const body = Buffer.from('{"action":"opened"}');
    const sig = makeSignature('{"action":"closed"}');
    expect(verifyGithubSignature(body, sig, SECRET)).toBe(false);
  });

  it('rejects missing sha256= prefix', () => {
    const body = Buffer.from('payload');
    const hex = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyGithubSignature(body, hex, SECRET)).toBe(false);
  });
});

describe('verifyGitlabToken', () => {
  it('accepts matching token', () => {
    expect(verifyGitlabToken('gitlab-test-secret', 'gitlab-test-secret')).toBe(true);
  });

  it('rejects wrong token', () => {
    expect(verifyGitlabToken('wrong', 'gitlab-test-secret')).toBe(false);
  });

  it('rejects missing header', () => {
    expect(verifyGitlabToken(undefined, 'gitlab-test-secret')).toBe(false);
  });

  it('rejects different length tokens (timing-safe)', () => {
    expect(verifyGitlabToken('short', 'much-longer-secret')).toBe(false);
  });
});

describe('isSafeBranchName', () => {
  it('accepts valid branch names', () => {
    expect(isSafeBranchName('main')).toBe(true);
    expect(isSafeBranchName('feature/my-feature')).toBe(true);
    expect(isSafeBranchName('fix-123')).toBe(true);
    expect(isSafeBranchName('release/v1.2.3')).toBe(true);
  });

  it('rejects names with shell-injection characters', () => {
    expect(isSafeBranchName('branch;rm -rf /')).toBe(false);
    expect(isSafeBranchName('branch$(evil)')).toBe(false);
    expect(isSafeBranchName('branch`whoami`')).toBe(false);
    expect(isSafeBranchName('branch&&evil')).toBe(false);
    expect(isSafeBranchName('branch|pipe')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isSafeBranchName('')).toBe(false);
  });

  it('rejects names git would parse as an option', () => {
    expect(isSafeBranchName('-foo')).toBe(false);
    expect(isSafeBranchName('--upload-pack')).toBe(false);
  });

  it('rejects ref-format violations and traversal', () => {
    expect(isSafeBranchName('a..b')).toBe(false);
    expect(isSafeBranchName('../etc')).toBe(false);
    expect(isSafeBranchName('feature/')).toBe(false);
    expect(isSafeBranchName('feature//x')).toBe(false);
    expect(isSafeBranchName('feature/.hidden')).toBe(false);
    expect(isSafeBranchName('topic.lock')).toBe(false);
    expect(isSafeBranchName('topic.')).toBe(false);
  });

  it('still accepts dots and dashes inside components', () => {
    expect(isSafeBranchName('release/v1.2.3-rc.1')).toBe(true);
    expect(isSafeBranchName('user/feature-x')).toBe(true);
  });
});
