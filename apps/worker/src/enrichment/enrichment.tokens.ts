/** DI tokens for the enrichment module (tests override these with fakes). */
export const ENRICHMENT_PROVIDER = Symbol('ENRICHMENT_PROVIDER');
export const WEBSITE_CANDIDATE_FINDER = Symbol('WEBSITE_CANDIDATE_FINDER');

/** An enrichment failure worth retrying (site unreachable, timeouts, 5xx). */
export class RetryableEnrichmentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'RetryableEnrichmentError';
  }
}
