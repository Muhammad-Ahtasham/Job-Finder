export type ProviderErrorCode =
  | 'RATE_LIMITED'
  | 'AUTH'
  | 'QUOTA_EXHAUSTED'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'BAD_REQUEST'
  | 'BAD_RESPONSE'
  | 'UNKNOWN';

/** Every provider failure is expressed as this so the worker can retry (or not) uniformly. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: ProviderErrorCode,
    public readonly options: { retryable: boolean; retryAfterMs?: number; httpStatus?: number },
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get retryable(): boolean {
    return this.options.retryable;
  }
  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }
  get httpStatus(): number | undefined {
    return this.options.httpStatus;
  }
}

/** Parse `Retry-After` (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function errorFromStatus(
  status: number,
  retryAfterHeader?: string | null,
  defaultRetryAfterMs?: number,
): ProviderError {
  const retryAfterMs = parseRetryAfter(retryAfterHeader) ?? defaultRetryAfterMs;
  if (status === 429) {
    return new ProviderError('Provider rate limit reached (HTTP 429)', 'RATE_LIMITED', {
      retryable: true,
      retryAfterMs,
      httpStatus: status,
    });
  }
  if (status === 401 || status === 403) {
    return new ProviderError(`Provider rejected credentials (HTTP ${status})`, 'AUTH', {
      retryable: false,
      httpStatus: status,
    });
  }
  if (status === 402) {
    return new ProviderError('Provider quota exhausted (HTTP 402)', 'QUOTA_EXHAUSTED', {
      retryable: false,
      httpStatus: status,
    });
  }
  if (status >= 500 || status === 408) {
    return new ProviderError(`Provider unavailable (HTTP ${status})`, 'UNAVAILABLE', {
      retryable: true,
      retryAfterMs,
      httpStatus: status,
    });
  }
  return new ProviderError(`Provider rejected the request (HTTP ${status})`, 'BAD_REQUEST', {
    retryable: false,
    httpStatus: status,
  });
}
