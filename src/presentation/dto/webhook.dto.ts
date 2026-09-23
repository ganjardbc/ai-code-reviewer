import { z } from 'zod';

export const githubIssueCommentSchema = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.object({}).passthrough().optional(),
  }),
  comment: z.object({
    id: z.number().int().positive(),
    body: z.string(),
    user: z.object({
      login: z.string().min(1),
    }),
  }),
  repository: z.object({
    name: z.string().min(1),
    owner: z.object({
      login: z.string().min(1),
    }),
    clone_url: z.url(),
  }),
});

export type GithubIssueCommentPayload = z.infer<typeof githubIssueCommentSchema>;

export const gitlabNoteHookSchema = z.object({
  object_kind: z.literal('note'),
  object_attributes: z.object({
    id: z.number().int().positive(),
    note: z.string(),
    noteable_type: z.string(),
  }),
  user: z.object({ id: z.number().int().positive() }),
  merge_request: z
    .object({
      iid: z.number().int().positive(),
      state: z.string(),
      source_branch: z.string().min(1),
      target_branch: z.string().min(1),
      last_commit: z.object({ id: z.string().min(1) }),
      source: z.object({ git_http_url: z.url() }).optional(),
      target: z.object({ git_http_url: z.url() }),
      diff_refs: z
        .object({
          base_sha: z.string().min(1),
          start_sha: z.string().min(1),
          head_sha: z.string().min(1),
        })
        .optional(),
    })
    .optional(),
  project: z.object({ id: z.number().int().positive() }),
});

export type GitlabNoteHookPayload = z.infer<typeof gitlabNoteHookSchema>;

export const githubWebhookSchema = z.object({
  action: z.string(),
  number: z.number().int().positive(),
  pull_request: z.object({
    head: z.object({
      ref: z.string().min(1),
      sha: z.string().min(1),
      // null when the fork has been deleted
      repo: z.object({ clone_url: z.url() }).nullable().optional(),
    }),
    base: z.object({
      ref: z.string().min(1),
    }),
  }),
  repository: z.object({
    name: z.string().min(1),
    owner: z.object({
      login: z.string().min(1),
    }),
    clone_url: z.url(),
  }),
});

export type GithubWebhookPayload = z.infer<typeof githubWebhookSchema>;

export const gitlabWebhookSchema = z.object({
  object_kind: z.literal('merge_request'),
  object_attributes: z.object({
    action: z.string(),
    iid: z.number().int().positive(),
    source_branch: z.string().min(1),
    target_branch: z.string().min(1),
    last_commit: z.object({
      id: z.string().min(1),
    }),
    source: z.object({
      git_http_url: z.url(),
    }).optional(),
    target: z.object({
      git_http_url: z.url(),
    }),
    diff_refs: z.object({
      base_sha: z.string().min(1),
      start_sha: z.string().min(1),
      head_sha: z.string().min(1),
    }).optional(),
  }),
  project: z.object({
    id: z.number().int().positive(),
  }),
});

export type GitlabWebhookPayload = z.infer<typeof gitlabWebhookSchema>;
