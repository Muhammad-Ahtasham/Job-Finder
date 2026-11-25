import type { BoardRef, JobDiscoveryProvider } from './types';

/** Looks providers up by id, and recognises which provider owns a URL. */
export class JobProviderRegistry {
  private readonly providers = new Map<string, JobDiscoveryProvider>();

  constructor(providers: JobDiscoveryProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: JobDiscoveryProvider): this {
    if (this.providers.has(provider.id))
      throw new Error(`Provider "${provider.id}" is already registered`);
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): JobDiscoveryProvider | undefined {
    return this.providers.get(id);
  }

  all(): JobDiscoveryProvider[] {
    return [...this.providers.values()];
  }

  /** First provider that recognises the URL as one of its boards. The generic fallback never does. */
  identify(url: string): { provider: JobDiscoveryProvider; board: BoardRef } | null {
    for (const provider of this.providers.values()) {
      if (provider.id === 'generic-html') continue;
      const board = provider.identify(url);
      if (board) return { provider, board };
    }
    return null;
  }
}
