import { fetchJson, ProviderError, type FetchLike } from '@jobfinder/discovery';
import { InMemoryDomainRateLimiter, type DomainRateLimiter } from '@jobfinder/enrichment';
import type { JobFetchError } from '../types';

export interface ApiClientOptions {
  userAgent: string;
  /** Spaces out requests per API host. Default: 1 request / second, in-process. */
  rateLimiter?: DomainRateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Greenhouse boards with `content=true` can be large. */
  maxBytes?: number;
}

export class ApiRequestError extends Error {
  constructor(readonly detail: JobFetchError) {
    super(detail.message);
  }
}

/**
 * GET + parse JSON from a vendor's public API (fixed hosts built by us, with a validated
 * board token in the path — never a URL taken from crawled content). Every failure becomes an
 * ApiRequestError carrying a JobFetchError so a failed call can never look like "no jobs".
 */
export class ApiClient {
  private readonly limiter: DomainRateLimiter;

  constructor(private readonly options: ApiClientOptions) {
    this.limiter = options.rateLimiter ?? new InMemoryDomainRateLimiter(1000);
  }

  async getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const host = new URL(url).hostname;
    try {
      await this.limiter.acquire(host, { signal });
      return await fetchJson(url, {
        headers: { accept: 'application/json', 'user-agent': this.options.userAgent },
        timeoutMs: this.options.timeoutMs ?? 20_000,
        maxBytes: this.options.maxBytes ?? 25 * 1024 * 1024,
        signal,
        fetchImpl: this.options.fetchImpl,
      });
    } catch (error) {
      throw new ApiRequestError(toJobFetchError(error));
    }
  }
}

export function toJobFetchError(error: unknown): JobFetchError {
  if (error instanceof ProviderError) {
    // A board that does not exist is not "zero openings": say so explicitly.
    if (error.httpStatus === 404) {
      return {
        code: 'BOARD_NOT_FOUND',
        message: 'The job board does not exist (HTTP 404)',
        retryable: false,
        httpStatus: 404,
      };
    }
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      httpStatus: error.httpStatus,
      retryAfterMs: error.retryAfterMs,
    };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'CANCELLED', message: 'Request cancelled', retryable: false };
  }
  return {
    code: 'UNEXPECTED',
    message: error instanceof Error ? error.message : 'Unexpected error',
    retryable: false,
  };
}

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

export const badShape = (what: string): ApiRequestError =>
  new ApiRequestError({
    code: 'BAD_RESPONSE',
    message: `Unexpected response shape: ${what}`,
    retryable: true,
  });
