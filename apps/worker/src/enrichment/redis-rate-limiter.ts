import type Redis from 'ioredis';
import {
  rateLimitKey,
  sleep,
  type AcquireOptions,
  type DomainRateLimiter,
} from '@jobfinder/enrichment';

/**
 * Per-domain request spacing shared by every worker replica. A request may proceed only if it
 * can set the domain's lease key (`SET NX PX interval`); otherwise it sleeps for the lease's
 * remaining time and tries again. So at most one request per `interval` reaches a domain, no
 * matter how many jobs or processes are crawling it.
 */
export class RedisDomainRateLimiter implements DomainRateLimiter {
  constructor(
    private readonly redis: Pick<Redis, 'set' | 'pttl'>,
    private readonly minIntervalMs: number,
    private readonly prefix = 'jf:enrich:rl:',
  ) {}

  async acquire(host: string, options: AcquireOptions = {}): Promise<void> {
    const key = `${this.prefix}${rateLimitKey(host)}`;
    const interval = Math.max(this.minIntervalMs, options.minIntervalMs ?? 0);
    for (;;) {
      if (options.signal?.aborted) throw options.signal.reason;
      const acquired = await this.redis.set(key, '1', 'PX', interval, 'NX');
      if (acquired === 'OK') return;
      const remaining = await this.redis.pttl(key);
      // pttl: -2 key vanished (retry now), -1 no expiry (should not happen; back off one interval)
      const wait = remaining >= 0 ? remaining : remaining === -1 ? interval : 0;
      await sleep(wait + Math.floor(Math.random() * 40), options.signal);
    }
  }
}
