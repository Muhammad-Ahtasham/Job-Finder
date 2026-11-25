export type FetchErrorCode =
  | 'INVALID_URL' // malformed, wrong scheme, credentials, bad port
  | 'BLOCKED_HOST' // localhost / internal names / IP literals
  | 'BLOCKED_ADDRESS' // resolved to a non-public IP
  | 'DNS_FAILED'
  | 'TOO_MANY_REDIRECTS'
  | 'BAD_REDIRECT'
  | 'ROBOTS_DISALLOWED'
  | 'ROBOTS_UNAVAILABLE' // robots.txt could not be read: RFC 9309 says do not crawl
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'RESPONSE_TOO_LARGE'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'CANCELLED';

/** Failures that mean "this URL is unsafe": never retried, always reported as blocked. */
const UNSAFE: ReadonlySet<FetchErrorCode> = new Set([
  'INVALID_URL',
  'BLOCKED_HOST',
  'BLOCKED_ADDRESS',
  'BAD_REDIRECT',
]);

const RETRYABLE: ReadonlySet<FetchErrorCode> = new Set([
  'TIMEOUT',
  'NETWORK_ERROR',
  'DNS_FAILED',
  'ROBOTS_UNAVAILABLE',
]);

export class FetchError extends Error {
  constructor(
    message: string,
    readonly code: FetchErrorCode,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'FetchError';
  }
  /** True when the URL itself was refused by the SSRF policy. */
  get unsafe(): boolean {
    return UNSAFE.has(this.code);
  }
  get retryable(): boolean {
    return (
      RETRYABLE.has(this.code) ||
      (this.code === 'HTTP_ERROR' &&
        this.httpStatus !== undefined &&
        (this.httpStatus >= 500 || this.httpStatus === 429 || this.httpStatus === 408))
    );
  }
}
