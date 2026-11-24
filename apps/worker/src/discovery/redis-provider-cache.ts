import type Redis from 'ioredis';
import type { ProviderCache } from '@jobfinder/discovery';

/** Response cache for providers whose policy requires caching (e.g. Overpass). */
export class RedisProviderCache implements ProviderCache {
  constructor(private readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }
}
