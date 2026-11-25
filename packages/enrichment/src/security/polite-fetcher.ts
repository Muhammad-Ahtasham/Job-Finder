import { FetchError } from './errors';
import { InMemoryDomainRateLimiter, type DomainRateLimiter } from './rate-limiter';
import {
  SafeFetcher,
  type RequestImpl,
  type SafeFetchOptions,
  type SafeFetchResult,
} from './safe-fetcher';
import type { DnsResolver } from './url-guard';
import { RobotsPolicy } from '../robots';

/** What the crawler needs from a fetcher; lets tests substitute an in-memory site. */
export interface PageFetcher {
  fetchText(url: string | URL, options: SafeFetchOptions): Promise<SafeFetchResult>;
}

export interface PoliteFetcherConfig {
  /** Full UA string; should identify the bot and a way to reach the operator. */
  userAgent: string;
  /** Product token matched against robots.txt `User-agent:` groups. */
  robotsToken?: string;
  /** Minimum spacing between requests to one registrable domain. */
  minIntervalMs?: number;
  rateLimiter?: DomainRateLimiter;
  resolver?: DnsResolver;
  requestImpl?: RequestImpl;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

const ROBOTS_TTL_MS = 60 * 60_000;
const ROBOTS_UNREADABLE_TTL_MS = 5 * 60_000;
const MAX_CRAWL_DELAY_MS = 30_000;

/**
 * SafeFetcher + robots.txt + per-domain rate limiting. robots.txt is evaluated for EVERY
 * hop, so a redirect cannot carry us into a disallowed path. robots.txt that cannot be read
 * (5xx, network error) means "do not crawl" (RFC 9309); a missing one (4xx) means "allowed".
 */
export class PoliteFetcher implements PageFetcher {
  private readonly fetcher: SafeFetcher;
  private readonly token: string;
  private readonly robots = new Map<string, { policy: Promise<RobotsPolicy>; expires: number }>();
  private readonly crawlDelays = new Map<string, number>();

  constructor(private readonly config: PoliteFetcherConfig) {
    this.token = config.robotsToken ?? 'JobFinderBot';
    const base = config.rateLimiter ?? new InMemoryDomainRateLimiter(config.minIntervalMs ?? 2000);
    this.fetcher = new SafeFetcher({
      userAgent: config.userAgent,
      resolver: config.resolver,
      requestImpl: config.requestImpl,
      timeoutMs: config.timeoutMs,
      maxBytes: config.maxBytes,
      maxRedirects: config.maxRedirects,
      rateLimiter: {
        acquire: (host, options) =>
          base.acquire(host, {
            ...options,
            minIntervalMs: Math.max(
              options?.minIntervalMs ?? 0,
              this.crawlDelays.get(host.toLowerCase()) ?? 0,
            ),
          }),
      },
      authorize: (url, signal) => this.authorize(url, signal),
    });
  }

  fetchText(url: string | URL, options: SafeFetchOptions): Promise<SafeFetchResult> {
    return this.fetcher.fetchText(url, options);
  }

  private async authorize(url: URL, signal: AbortSignal | undefined): Promise<void> {
    const policy = await this.policyFor(url, signal);
    if (!policy) {
      throw new FetchError(`robots.txt of ${url.host} could not be read`, 'ROBOTS_UNAVAILABLE');
    }
    if (!policy.isAllowed(`${url.pathname}${url.search}`, this.token)) {
      throw new FetchError(`robots.txt of ${url.host} disallows this path`, 'ROBOTS_DISALLOWED');
    }
    const delay = policy.crawlDelayMs(this.token);
    if (delay !== undefined) {
      this.crawlDelays.set(url.hostname.toLowerCase(), Math.min(delay, MAX_CRAWL_DELAY_MS));
    }
  }

  /** `undefined` = robots.txt unreadable (do not crawl). */
  private async policyFor(
    url: URL,
    signal: AbortSignal | undefined,
  ): Promise<RobotsPolicy | undefined> {
    const key = url.origin;
    let entry = this.robots.get(key);
    if (!entry || entry.expires <= Date.now()) {
      const policy = this.loadRobots(url, signal);
      entry = { policy, expires: Date.now() + ROBOTS_TTL_MS };
      this.robots.set(key, entry);
      // Retry an unreadable robots.txt soon rather than blocking the site for an hour.
      policy.then(
        (loaded) => {
          if (loaded.isUnreadable) entry!.expires = Date.now() + ROBOTS_UNREADABLE_TTL_MS;
        },
        () => this.robots.delete(key),
      );
    }
    const loaded = await entry.policy;
    return loaded.isUnreadable ? undefined : loaded;
  }

  private async loadRobots(url: URL, signal: AbortSignal | undefined): Promise<RobotsPolicy> {
    try {
      const result = await this.fetcher.fetchText(new URL('/robots.txt', url.origin), {
        allowedContentTypes: ['text/plain', 'text/html'],
        accept: 'text/plain,*/*;q=0.1',
        maxBytes: 512 * 1024,
        signal,
        skipAuthorize: true,
      });
      return RobotsPolicy.parse(result.body);
    } catch (error) {
      if (error instanceof FetchError) {
        // 4xx (missing) → no restrictions. Everything else → unreadable.
        if (error.code === 'HTTP_ERROR' && error.httpStatus && error.httpStatus < 500) {
          return RobotsPolicy.allowAll();
        }
        if (error.code === 'UNSUPPORTED_CONTENT_TYPE') return RobotsPolicy.allowAll();
        if (error.unsafe) throw error;
      }
      return RobotsPolicy.unreadable();
    }
  }
}
