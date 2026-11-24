import { errorFromStatus, ProviderError } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchJsonOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  defaultRetryAfterMs?: number;
}

/**
 * Minimal, defensive JSON fetch for *trusted vendor APIs* (the URLs come from our own
 * configuration, never from crawled content). Applies a timeout and a response size cap
 * and maps every failure to ProviderError.
 */
export async function fetchJson(url: string, options: FetchJsonOptions = {}): Promise<unknown> {
  const {
    method = 'GET',
    headers,
    body,
    timeoutMs = 30_000,
    maxBytes = 8 * 1024 * 1024,
    signal,
    fetchImpl = fetch,
    defaultRetryAfterMs,
  } = options;

  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetchImpl(url, { method, headers, body, signal: combined, redirect: 'error' });
  } catch (error) {
    if (signal?.aborted) {
      throw new ProviderError('Request cancelled', 'UNKNOWN', { retryable: false });
    }
    const timedOut = timeout.aborted || (error instanceof Error && error.name === 'TimeoutError');
    throw new ProviderError(
      timedOut ? 'Provider request timed out' : 'Provider request failed (network error)',
      timedOut ? 'TIMEOUT' : 'UNAVAILABLE',
      { retryable: true },
    );
  }

  if (!response.ok) {
    throw errorFromStatus(
      response.status,
      response.headers.get('retry-after'),
      defaultRetryAfterMs,
    );
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProviderError('Provider response too large', 'BAD_RESPONSE', { retryable: false });
  }
  const text = await response.text();
  if (text.length > maxBytes) {
    throw new ProviderError('Provider response too large', 'BAD_RESPONSE', { retryable: false });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('Provider returned invalid JSON', 'BAD_RESPONSE', { retryable: true });
  }
}
