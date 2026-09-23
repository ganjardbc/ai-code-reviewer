import { spawnSync } from 'node:child_process';
import { logger } from './infrastructure/logging/logger.js';
import { QueueWorker } from './infrastructure/queue/worker.js';
import { ProcessReviewUseCase } from './application/use-cases/process-review.use-case.js';
import { ProcessFixUseCase } from './application/use-cases/process-fix.use-case.js';
import { GitService } from './infrastructure/git/git.service.js';
import { WorkspaceManager } from './infrastructure/git/workspace.manager.js';
import { createRunner } from './infrastructure/ai/runner.factory.js';
import { promptService } from './application/services/prompt.service.js';
import { parserService } from './application/services/parser.service.js';
import { githubService } from './infrastructure/vcs/github.service.js';
import { gitlabService } from './infrastructure/vcs/gitlab.service.js';
import { TelegramNotifier } from './infrastructure/notifications/telegram.notifier.js';
import { config } from './config/index.js';
import type { JobPayload } from './domain/interfaces/queue.interface.js';

// Fail at startup, not on every job, when the opencode CLI is missing
// (e.g. an image built without INSTALL_OPENCODE=true).
if (config.AI_RUNNER === 'opencode') {
  const probe = spawnSync(config.OPENCODE_COMMAND, ['--version'], { stdio: 'ignore', timeout: 30_000 });
  if (probe.error) {
    logger.fatal(`AI_RUNNER=opencode but '${config.OPENCODE_COMMAND}' could not be run`, probe.error);
    process.exit(1);
  }
}

const aiProvider = createRunner(parserService);
const workspaceManager = new WorkspaceManager();

const notifier =
  config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID
    ? new TelegramNotifier(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID)
    : undefined;

const reviewUseCase = new ProcessReviewUseCase({
  gitService: new GitService(),
  workspaceManager,
  aiProvider,
  promptBuilder: promptService,
  outputParser: parserService,
  githubClient: githubService,
  gitlabClient: gitlabService,
  notifier,
});

const fixUseCase = new ProcessFixUseCase({
  gitService: new GitService(),
  workspaceManager,
  aiProvider,
  fixPromptBuilder: promptService,
  githubClient: githubService,
  gitlabClient: gitlabService,
  notifier,
});

const worker = new QueueWorker(async (job) => {
  const payload = job.data as JobPayload;
  const ctx = { isFinalAttempt: job.isFinalAttempt };
  if (payload.jobType === 'fix') {
    await fixUseCase.execute(payload, ctx);
  } else {
    await reviewUseCase.execute(payload, ctx);
  }
});

worker.start();
void workspaceManager.sweepStaleWorkspaces();

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down worker`);
  try {
    await worker.stop();
    process.exit(0);
  } catch (err) {
    logger.fatal('Worker shutdown error', err instanceof Error ? err : new Error(String(err)));
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
