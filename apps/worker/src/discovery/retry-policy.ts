import { ProviderError } from '@jobfinder/discovery';

export const PROVIDER_BACKOFF = 'provider-exponential';
const MAX_DELAY_MS = 5 * 60_000;

/**
 * Exponential backoff with ±30% jitter, never shorter than a provider-supplied
 * `Retry-After`. `attemptsMade` is the number of failures so far (BullMQ semantics).
 */
export function backoffDelay(
  attemptsMade: number,
  baseMs: number,
  error?: Error,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(attemptsMade - 1, 0), MAX_DELAY_MS);
  const jittered = Math.round(exponential * (0.7 + random() * 0.6));
  const retryAfter = error instanceof ProviderError ? (error.retryAfterMs ?? 0) : 0;
  return Math.max(jittered, retryAfter);
}
