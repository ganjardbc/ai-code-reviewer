import '../mocks/env.js';
import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { reviewQueue } from '../../src/infrastructure/queue/client.js';
import { githubService } from '../../src/infrastructure/vcs/github.service.js';
import { gitlabService } from '../../src/infrastructure/vcs/gitlab.service.js';

// Mock queue so no real Redis needed
vi.mock('../../src/infrastructure/queue/client.js', () => ({
  reviewQueue: {
    addJob: vi.fn().mockResolvedValue('mock-job-id'),
    close: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock Redis connection for health check
vi.mock('../../src/infrastructure/queue/connection.js', () => ({
  getRedisClient: vi.fn(() => ({
    ping: vi.fn().mockResolvedValue('PONG'),
  })),
  getRedisConnectionOptions: vi.fn(() => ({})),
  closeRedisConnection: vi.fn().mockResolvedValue(undefined),
}));

// Mock VCS clients so comment-trigger routes don't make real API calls
vi.mock('../../src/infrastructure/vcs/github.service.js', () => ({
  githubService: {
    getPullRequest: vi.fn().mockResolvedValue({
      headRef: 'feature-x',
      baseRef: 'main',
      headSha: 'abc1234567890abcdef',
      cloneUrl: 'https://github.com/myorg/myrepo.git',
      state: 'open',
    }),
    hasWriteAccess: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../../src/infrastructure/vcs/gitlab.service.js', () => ({
  gitlabService: {
    getMergeRequest: vi.fn().mockResolvedValue({
      baseSha: 'base123',
      startSha: 'start456',
      headSha: 'def567890abcdef1234',
    }),
    hasDeveloperAccess: vi.fn().mockResolvedValue(true),
  },
}));

import { buildApp } from '../../src/presentation/web/app.js';

const GITHUB_SECRET = 'github-test-secret';
const GITLAB_SECRET = 'gitlab-test-secret';

const GITHUB_PAYLOAD = {
  action: 'opened',
  number: 42,
  pull_request: {
    head: { ref: 'feature-x', sha: 'abc1234567890abcdef' },
    base: { ref: 'main' },
  },
  repository: {
    name: 'myrepo',
    owner: { login: 'myorg' },
    clone_url: 'https://github.com/myorg/myrepo.git',
  },
};

const GITLAB_PAYLOAD = {
  object_kind: 'merge_request',
  object_attributes: {
    action: 'open',
    iid: 5,
    source_branch: 'feature-y',
    target_branch: 'main',
    last_commit: { id: 'def567890abcdef1234' },
    target: { git_http_url: 'https://gitlab.com/myorg/myrepo.git' },
  },
  project: { id: 123 },
};

function githubSig(body: string): string {
  return 'sha256=' + createHmac('sha256', GITHUB_SECRET).update(body).digest('hex');
}

describe('Webhook Integration', () => {
  let app: ReturnType<typeof buildApp>;
  let request: ReturnType<typeof supertest>;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    request = supertest(app.server);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /health', () => {
    it('returns 200 with healthy status', async () => {
      const res = await request.get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.services).toHaveProperty('redis');
      expect(res.body.services).toHaveProperty('disk');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('POST /webhooks/github', () => {
    it('returns 202 for valid PR webhook', async () => {
      const body = JSON.stringify(GITHUB_PAYLOAD);
      const res = await request
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', githubSig(body))
        .send(body);

      expect(res.status).toBe(202);
      expect(res.body.status).toBe('enqueued');
      expect(res.body.jobId).toBeDefined();
    });

    it('uses a jobId derived from the head SHA so redeliveries deduplicate', async () => {
      const body = JSON.stringify(GITHUB_PAYLOAD);
      await request
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', githubSig(body))
        .send(body);

      expect(reviewQueue.addJob).toHaveBeenLastCalledWith(
        'github-review',
        expect.objectContaining({ jobId: 'github-review-myorg-myrepo-42-abc1234567890abcdef', trigger: 'event' }),
        { jobId: 'github-review-myorg-myrepo-42-abc1234567890abcdef' },
      );
    });

    it('records the fork clone URL for PRs from forks', async () => {
      const payload = {
        ...GITHUB_PAYLOAD,
        pull_request: {
          ...GITHUB_PAYLOAD.pull_request,
          head: { ...GITHUB_PAYLOAD.pull_request.head, repo: { clone_url: 'https://github.com/contributor/myrepo.git' } },
        },
      };
      const body = JSON.stringify(payload);
      await request
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', githubSig(body))
        .send(body);

      expect(reviewQueue.addJob).toHaveBeenLastCalledWith(
        'github-review',
        expect.objectContaining({
          cloneUrl: 'https://github.com/myorg/myrepo.git',
          headCloneUrl: 'https://github.com/contributor/myrepo.git',
        }),
        expect.anything(),
      );
    });

    it('returns 401 for missing signature', async () => {
      const res = await request
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(GITHUB_PAYLOAD));

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 401 for wrong signature', async () => {
      const res = await request
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', 'sha256=badhex')
        .send(JSON.stringify(GITHUB_PAYLOAD));

      expect(res.status).toBe(401);
    });

    it('returns 200 ignored for non-PR-open actions', async () => {
      const body = JSON.stringify({ ...GITHUB_PAYLOAD, action: 'closed' });
      const res = await request
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', githubSig(body))
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ignored');
    });

    it('returns 400 for invalid payload structure', async () => {
      const body = JSON.stringify({ action: 'opened' });
      const res = await request
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', githubSig(body))
        .send(body);

      expect(res.status).toBe(400);
    });

    it('returns 200 ignored for ping event', async () => {
      const body = JSON.stringify({ zen: 'Non-blocking is better than blocking.' });
      const res = await request
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', githubSig(body))
        .set('X-GitHub-Event', 'ping')
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ignored');
      expect(res.body.reason).toBe('Unsupported event: ping');
    });
  });

  describe('POST /webhooks/gitlab', () => {
    it('returns 202 for valid MR webhook', async () => {
      const res = await request
        .post('/webhooks/gitlab')
        .set('Content-Type', 'application/json')
        .set('X-Gitlab-Token', GITLAB_SECRET)
        .send(JSON.stringify(GITLAB_PAYLOAD));

      expect(res.status).toBe(202);
      expect(res.body.status).toBe('enqueued');
      expect(res.body.jobId).toBeDefined();
    });

    it('never embeds the access token in the enqueued clone URL', async () => {
      await request
        .post('/webhooks/gitlab')
        .set('Content-Type', 'application/json')
        .set('X-Gitlab-Token', GITLAB_SECRET)
        .send(JSON.stringify(GITLAB_PAYLOAD));

      const data = vi.mocked(reviewQueue.addJob).mock.lastCall?.[1] as { cloneUrl: string; jobId: string };
      expect(data.cloneUrl).toBe('https://gitlab.com/myorg/myrepo.git');
      expect(JSON.stringify(data)).not.toContain('test-gl-token');
      expect(data.jobId).toBe('gitlab-review-123-5-def567890abcdef1234');
    });

    it('returns 401 for wrong token', async () => {
      const res = await request
        .post('/webhooks/gitlab')
        .set('Content-Type', 'application/json')
        .set('X-Gitlab-Token', 'wrongtoken')
        .send(JSON.stringify(GITLAB_PAYLOAD));

      expect(res.status).toBe(401);
    });

    it('returns 401 for missing token', async () => {
      const res = await request
        .post('/webhooks/gitlab')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(GITLAB_PAYLOAD));

      expect(res.status).toBe(401);
    });

    it('returns 200 ignored for non-open MR actions', async () => {
      const payload = {
        ...GITLAB_PAYLOAD,
        object_attributes: { ...GITLAB_PAYLOAD.object_attributes, action: 'close' },
      };
      const res = await request
        .post('/webhooks/gitlab')
        .set('Content-Type', 'application/json')
        .set('X-Gitlab-Token', GITLAB_SECRET)
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ignored');
    });

    it('returns 200 ignored for unsupported system event', async () => {
      const payload = { event_name: 'project_create' };
      const res = await request
        .post('/webhooks/gitlab')
        .set('Content-Type', 'application/json')
        .set('X-Gitlab-Token', GITLAB_SECRET)
        .set('X-Gitlab-Event', 'System Hook')
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ignored');
      expect(res.body.reason).toBe('Unsupported event: System Hook');
    });

    it('enqueues job with baseSha and startSha if diff_refs present', async () => {
      const payload = {
        ...GITLAB_PAYLOAD,
        object_attributes: {
          ...GITLAB_PAYLOAD.object_attributes,
          diff_refs: {
            base_sha: 'base123',
            start_sha: 'start456',
            head_sha: 'head789',
          },
        },
      };
      const res = await request
        .post('/webhooks/gitlab')
        .set('Content-Type', 'application/json')
        .set('X-Gitlab-Token', GITLAB_SECRET)
        .send(JSON.stringify(payload));

      expect(res.status).toBe(202);
      expect(reviewQueue.addJob).toHaveBeenCalledWith(
        'gitlab-review',
        expect.objectContaining({
          baseSha: 'base123',
          startSha: 'start456',
        }),
        expect.anything(),
      );
    });
  });

  describe('POST /webhooks/github — /fix comment trigger', () => {
    const ISSUE_COMMENT_PAYLOAD = {
      action: 'created',
      issue: {
        number: 42,
        pull_request: {},
      },
      comment: { id: 9001, body: '/fix', user: { login: 'maintainer' } },
      repository: {
        name: 'myrepo',
        owner: { login: 'myorg' },
        clone_url: 'https://github.com/myorg/myrepo.git',
      },
    };

    it('enqueues a fix job for /fix comment', async () => {
      const body = JSON.stringify(ISSUE_COMMENT_PAYLOAD);
      const res = await request
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'issue_comment')
        .set('X-Hub-Signature-256', githubSig(body))
        .send(body);

      expect(res.status).toBe(202);
      expect(res.body.status).toBe('enqueued');
      expect(reviewQueue.addJob).toHaveBeenCalledWith(
        'github-fix',
        expect.objectContaining({ jobType: 'fix', trigger: 'comment', provider: 'github', prNumber: 42 }),
        { jobId: 'github-fix-comment-9001' },
      );
    });

    it('ignores commands on a closed pull request', async () => {
      vi.mocked(githubService.getPullRequest).mockResolvedValueOnce({
        headRef: 'feature-x',
        baseRef: 'main',
        headSha: 'abc1234567890abcdef',
        cloneUrl: 'https://github.com/myorg/myrepo.git',
        state: 'closed',
      });
      vi.mocked(reviewQueue.addJob).mockClear();
      const body = JSON.stringify(ISSUE_COMMENT_PAYLOAD);
      const res = await request
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'issue_comment')
        .set('X-Hub-Signature-256', githubSig(body))
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.reason).toBe('Pull request is not open');
      expect(reviewQueue.addJob).not.toHaveBeenCalled();
    });

    it('enqueues a review job for /review comment', async () => {
      const payload = { ...ISSUE_COMMENT_PAYLOAD, comment: { ...ISSUE_COMMENT_PAYLOAD.comment, body: '/review' } };
      const body = JSON.stringify(payload);
      const res = await request
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'issue_comment')
        .set('X-Hub-Signature-256', githubSig(body))
        .send(body);

      expect(res.status).toBe(202);
      expect(reviewQueue.addJob).toHaveBeenCalledWith(
        'github-review',
        expect.objectContaining({ jobType: 'review', provider: 'github' }),
        { jobId: 'github-review-comment-9001' },
      );
    });

    it('ignores comments without /review or /fix', async () => {
      const payload = { ...ISSUE_COMMENT_PAYLOAD, comment: { ...ISSUE_COMMENT_PAYLOAD.comment, body: 'looks good to me' } };
      const body = JSON.stringify(payload);
      const res = await request
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'issue_comment')
        .set('X-Hub-Signature-256', githubSig(body))
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ignored');
    });

    it('ignores commands from commenters without write access', async () => {
      vi.mocked(githubService.hasWriteAccess).mockResolvedValueOnce(false);
      vi.mocked(reviewQueue.addJob).mockClear();
      const payload = { ...ISSUE_COMMENT_PAYLOAD, comment: { id: 9002, body: '/fix', user: { login: 'drive-by' } } };
      const body = JSON.stringify(payload);
      const res = await request
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'issue_comment')
        .set('X-Hub-Signature-256', githubSig(body))
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ignored');
      expect(githubService.hasWriteAccess).toHaveBeenCalledWith('myorg', 'myrepo', 'drive-by');
      expect(reviewQueue.addJob).not.toHaveBeenCalled();
    });

    it('returns 500 and enqueues nothing when the permission check fails', async () => {
      vi.mocked(githubService.hasWriteAccess).mockRejectedValueOnce(new Error('rate limited'));
      vi.mocked(reviewQueue.addJob).mockClear();
      const body = JSON.stringify(ISSUE_COMMENT_PAYLOAD);
      const res = await request
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'issue_comment')
        .set('X-Hub-Signature-256', githubSig(body))
        .send(body);

      expect(res.status).toBe(500);
      expect(reviewQueue.addJob).not.toHaveBeenCalled();
    });
  });

  describe('POST /webhooks/gitlab — /fix comment trigger', () => {
    const NOTE_HOOK_PAYLOAD = {
      object_kind: 'note',
      object_attributes: {
        id: 555,
        note: '/fix',
        noteable_type: 'MergeRequest',
      },
      user: { id: 77 },
      merge_request: {
        iid: 5,
        state: 'opened',
        source_branch: 'feature-y',
        target_branch: 'main',
        last_commit: { id: 'def567890abcdef1234' },
        target: { git_http_url: 'https://gitlab.com/myorg/myrepo.git' },
        diff_refs: {
          base_sha: 'base123',
          start_sha: 'start456',
          head_sha: 'def567890abcdef1234',
        },
      },
      project: { id: 123 },
    };

    it('enqueues a fix job for /fix note', async () => {
      const res = await request
        .post('/webhooks/gitlab')
        .set('Content-Type', 'application/json')
        .set('X-Gitlab-Token', GITLAB_SECRET)
        .set('X-Gitlab-Event', 'Note Hook')
        .send(JSON.stringify(NOTE_HOOK_PAYLOAD));

      expect(res.status).toBe(202);
      expect(reviewQueue.addJob).toHaveBeenCalledWith(
        'gitlab-fix',
        expect.objectContaining({
          jobType: 'fix',
          trigger: 'comment',
          provider: 'gitlab',
          mrIid: 5,
          cloneUrl: 'https://gitlab.com/myorg/myrepo.git',
        }),
        { jobId: 'gitlab-fix-comment-555' },
      );
    });

    it('ignores notes on a merged merge request', async () => {
      vi.mocked(reviewQueue.addJob).mockClear();
      const payload = { ...NOTE_HOOK_PAYLOAD, merge_request: { ...NOTE_HOOK_PAYLOAD.merge_request, state: 'merged' } };
      const res = await request
        .post('/webhooks/gitlab')
        .set('Content-Type', 'application/json')
        .set('X-Gitlab-Token', GITLAB_SECRET)
        .set('X-Gitlab-Event', 'Note Hook')
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      expect(res.body.reason).toBe('Merge request is not open');
      expect(reviewQueue.addJob).not.toHaveBeenCalled();
    });

    it('passes the fork URL separately for fork merge requests', async () => {
      const payload = {
        ...NOTE_HOOK_PAYLOAD,
        merge_request: { ...NOTE_HOOK_PAYLOAD.merge_request, source: { git_http_url: 'https://gitlab.com/contributor/myrepo.git' } },
      };
      await request
        .post('/webhooks/gitlab')
        .set('Content-Type', 'application/json')
        .set('X-Gitlab-Token', GITLAB_SECRET)
        .set('X-Gitlab-Event', 'Note Hook')
        .send(JSON.stringify(payload));

      expect(reviewQueue.addJob).toHaveBeenLastCalledWith(
        'gitlab-fix',
        expect.objectContaining({
          cloneUrl: 'https://gitlab.com/myorg/myrepo.git',
          headCloneUrl: 'https://gitlab.com/contributor/myrepo.git',
        }),
        expect.anything(),
      );
    });

    it('ignores notes without /review or /fix', async () => {
      const payload = { ...NOTE_HOOK_PAYLOAD, object_attributes: { ...NOTE_HOOK_PAYLOAD.object_attributes, note: 'lgtm' } };
      const res = await request
        .post('/webhooks/gitlab')
        .set('Content-Type', 'application/json')
        .set('X-Gitlab-Token', GITLAB_SECRET)
        .set('X-Gitlab-Event', 'Note Hook')
        .send(JSON.stringify(payload));

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ignored');
    });

    it('ignores notes from users without Developer access', async () => {
      vi.mocked(gitlabService.hasDeveloperAccess).mockResolvedValueOnce(false);
      vi.mocked(reviewQueue.addJob).mockClear();
      const res = await request
        .post('/webhooks/gitlab')
        .set('Content-Type', 'application/json')
        .set('X-Gitlab-Token', GITLAB_SECRET)
        .set('X-Gitlab-Event', 'Note Hook')
        .send(JSON.stringify(NOTE_HOOK_PAYLOAD));

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ignored');
      expect(gitlabService.hasDeveloperAccess).toHaveBeenCalledWith(123, 77);
      expect(reviewQueue.addJob).not.toHaveBeenCalled();
    });
  });
});

