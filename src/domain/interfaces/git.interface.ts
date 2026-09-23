/**
 * HTTP credentials for git. Passed per call and injected via GIT_CONFIG_*
 * environment variables, so tokens never appear in clone URLs, process argv,
 * `.git/config`, or the job payload stored in Redis.
 */
export interface GitAuth {
  username: string;
  token: string;
}

export interface IGitService {
  clone(repoUrl: string, branch: string, targetDir: string, auth?: GitAuth): Promise<void>;
  /** Fetches `ref` (e.g. `refs/pull/42/head`) from origin so its commits can be checked out. */
  fetchRef(targetDir: string, ref: string, auth?: GitAuth): Promise<void>;
  checkout(targetDir: string, commitSha: string): Promise<void>;
  generateDiff(targetDir: string, baseBranch: string, auth?: GitAuth): Promise<string>;
  commitAll(targetDir: string, message: string): Promise<boolean>;
  push(targetDir: string, remoteUrl: string, branch: string, auth?: GitAuth): Promise<void>;
}

export interface IWorkspaceManager {
  createWorkspace(): Promise<string>;
  cleanupWorkspace(dirPath: string): Promise<void>;
  validatePath(dirPath: string): boolean;
}

export interface IDiffGenerator {
  getDiff(workspacePath: string, base: string, head: string): Promise<string>;
}
