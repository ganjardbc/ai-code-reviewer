export interface AddJobOptions {
  /** Deterministic id: BullMQ ignores an add whose jobId already exists, deduplicating redeliveries. */
  jobId?: string;
}

export interface IQueue {
  addJob(name: string, data: Record<string, unknown>, options?: AddJobOptions): Promise<string>;
  close(): Promise<void>;
}

export interface JobPayload {
  jobId: string;
  jobType: 'review' | 'fix';
  /** 'event' = PR/MR lifecycle webhook, 'comment' = /review or /fix command. */
  trigger?: 'event' | 'comment';
  provider: 'github' | 'gitlab';
  /** Base (target) repository URL, without credentials. */
  cloneUrl: string;
  /** Head (source) repository URL when the PR/MR comes from a fork; absent for same-repo PRs. */
  headCloneUrl?: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  prNumber?: number;
  mrIid?: number;
  repoOwner?: string;
  repoName?: string;
  projectId?: number;
  baseSha?: string;
  startSha?: string;
}

export interface JobContext {
  /** False while BullMQ will still retry this job on failure; use cases only notify on the final attempt. */
  isFinalAttempt: boolean;
}

export type JobRunner = (job: { name: string; data: JobPayload; id: string } & JobContext) => Promise<void>;
