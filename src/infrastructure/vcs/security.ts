import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGithubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) {
    return false;
  }

  const provided = Buffer.from(signatureHeader.slice(7), 'hex');

  const expected = Buffer.from(
    createHmac('sha256', secret).update(rawBody).digest('hex'),
    'hex',
  );

  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}

export function verifyGitlabToken(
  tokenHeader: string | undefined,
  secret: string,
): boolean {
  if (!tokenHeader) {
    return false;
  }

  // Hash both sides to a fixed length first: comparing raw buffers needs an
  // early length check, which leaks the secret's length through timing.
  const provided = createHash('sha256').update(tokenHeader).digest();
  const expected = createHash('sha256').update(secret).digest();

  return timingSafeEqual(provided, expected);
}

const BRANCH_PATTERN = /^[a-zA-Z0-9_\-\/\.:]+$/;

/**
 * Allow-list of characters plus the `git check-ref-format` rules that matter
 * for safety: no leading '-' (would parse as a git option), no '..' (range
 * syntax / path traversal), and no empty or dot-prefixed path components.
 */
export function isSafeBranchName(branch: string): boolean {
  if (!BRANCH_PATTERN.test(branch)) return false;
  if (branch.startsWith('-') || branch.includes('..')) return false;
  if (branch.endsWith('/') || branch.endsWith('.') || branch.endsWith('.lock')) return false;
  return branch.split('/').every((part) => part.length > 0 && !part.startsWith('.'));
}
