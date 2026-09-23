export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;
  /** True when retrying cannot succeed (bad input, bad credentials); the worker then fails the job immediately. */
  readonly permanent: boolean = false;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  readonly statusCode = 400;
  override readonly permanent = true;
}

export class UnauthorizedError extends AppError {
  readonly code = 'UNAUTHORIZED';
  readonly statusCode = 401;
}

export class GitError extends AppError {
  readonly code = 'GIT_ERROR';
  readonly statusCode = 500;
}

export class AiProviderError extends AppError {
  readonly code = 'AI_PROVIDER_ERROR';
  readonly statusCode = 502;
  override readonly permanent: boolean;

  constructor(message: string, options: { permanent?: boolean } = {}) {
    super(message);
    this.permanent = options.permanent ?? false;
  }
}

export function isPermanentError(err: unknown): boolean {
  return err instanceof AppError && err.permanent;
}
