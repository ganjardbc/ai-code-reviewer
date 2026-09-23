import type { AiReviewComment } from './ai-provider.interface.js';

export interface PostReviewOptions {
  owner: string;
  repo: string;
  pullNumber: number;
  commitSha: string;
  comments: AiReviewComment[];
}

export interface PostMrReviewOptions {
  projectId: number;
  mrIid: number;
  baseSha: string;
  startSha: string;
  headSha: string;
  comments: AiReviewComment[];
}

export interface PullRequestInfo {
  headRef: string;
  baseRef: string;
  headSha: string;
  cloneUrl: string;
  /** Fork clone URL; undefined for same-repo PRs or when the fork was deleted. */
  headCloneUrl?: string;
  state: 'open' | 'closed';
}

export interface OutstandingComment {
  filePath: string;
  lineNumber: number;
  message: string;
}

export interface PostFixReplyOptions {
  owner: string;
  repo: string;
  pullNumber: number;
  body: string;
}

export interface IGithubClient {
  postReview(options: PostReviewOptions): Promise<void>;
  getPullRequest(owner: string, repo: string, pullNumber: number): Promise<PullRequestInfo>;
  listOutstandingBotComments(owner: string, repo: string, pullNumber: number): Promise<OutstandingComment[]>;
  postIssueComment(options: PostFixReplyOptions): Promise<void>;
  hasWriteAccess(owner: string, repo: string, username: string): Promise<boolean>;
}

export interface MergeRequestInfo {
  baseSha: string;
  startSha: string;
  headSha: string;
}

export interface PostMrFixReplyOptions {
  projectId: number;
  mrIid: number;
  body: string;
}

export interface IGitlabClient {
  postReview(options: PostMrReviewOptions): Promise<void>;
  getMergeRequest(projectId: number, mrIid: number): Promise<MergeRequestInfo>;
  listOutstandingBotComments(projectId: number, mrIid: number): Promise<OutstandingComment[]>;
  postMrNote(options: PostMrFixReplyOptions): Promise<void>;
  hasDeveloperAccess(projectId: number, userId: number): Promise<boolean>;
}
