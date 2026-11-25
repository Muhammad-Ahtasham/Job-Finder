import { parse } from 'tldts';

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Raise (never lower) the spacing for this host, e.g. robots.txt Crawl-delay. */
  minIntervalMs?: number;
}

/** Spaces out requests to one site. Implementations must be safe for concurrent callers. */
export interface DomainRateLimiter {
  acquire(host: string, options?: AcquireOptions): Promise<void>;
}

/** Budget is per registrable domain so www./careers./blog. share it. */
export function rateLimitKey(host: string): string {
  return parse(host, { allowPrivateDomains: true }).domain ?? host.toLowerCase();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Reservation-based limiter: each caller claims the next free slot, so concurrent callers
 * queue in order instead of stampeding. Process-local; the worker uses a Redis-backed
 * implementation so several replicas share one budget.
 */
export class InMemoryDomainRateLimiter implements DomainRateLimiter {
  private readonly nextSlot = new Map<string, number>();

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(host: string, options: AcquireOptions = {}): Promise<void> {
    const key = rateLimitKey(host);
    const interval = Math.max(this.minIntervalMs, options.minIntervalMs ?? 0);
    const now = this.now();
    const start = Math.max(now, this.nextSlot.get(key) ?? 0);
    this.nextSlot.set(key, start + interval);
    await sleep(start - now, options.signal);
  }
}
