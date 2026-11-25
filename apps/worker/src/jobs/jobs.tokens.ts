/** DI tokens for the jobs module (tests override these with fakes). */
export const JOB_PROVIDER_REGISTRY = Symbol('JOB_PROVIDER_REGISTRY');
export const CAREER_DISCOVERY = Symbol('CAREER_DISCOVERY');
export const JOB_AI_EXTRACTOR = Symbol('JOB_AI_EXTRACTOR');

/** Nothing could be learned because every source was unreachable: worth retrying. */
export class RetryableJobError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'RetryableJobError';
  }
}
