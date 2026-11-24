import type { CompanyDiscoveryProvider } from '@jobfinder/discovery';

export class ProviderRegistry {
  private readonly byId: Map<string, CompanyDiscoveryProvider>;

  constructor(public readonly providers: CompanyDiscoveryProvider[]) {
    this.byId = new Map(providers.map((provider) => [provider.id, provider]));
  }

  get(id: string): CompanyDiscoveryProvider | undefined {
    return this.byId.get(id);
  }
}
