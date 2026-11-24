import type { FetchLike } from '../http';
import type { CompanyDiscoveryProvider } from '../types';
import { BraveSearchProvider } from './brave-search.provider';
import { createFixtureProviders } from './fixture.provider';
import { OverpassProvider, type ProviderCache } from './overpass.provider';

export interface ProviderFactoryConfig {
  /** Provider ids the operator wants active, e.g. ['overpass-osm', 'brave-search']. */
  enabled: string[];
  userAgent: string;
  /** Synthetic dev/demo providers; the caller passes false in production. */
  allowFixtures?: boolean;
  brave?: {
    apiKey?: string;
    /** The operator confirms their Brave plan grants storage rights (required to persist results). */
    storageRightsConfirmed?: boolean;
    requestsPerSecond?: number;
    pagesPerQuery?: number;
  };
  overpass?: { endpoint?: string; minIntervalMs?: number; cache?: ProviderCache };
  fetchImpl?: FetchLike;
}

export interface SkippedProvider {
  id: string;
  reason: string;
}

export interface ProviderSet {
  providers: CompanyDiscoveryProvider[];
  skipped: SkippedProvider[];
}

export const KNOWN_PROVIDER_IDS = [
  'overpass-osm',
  'brave-search',
  'fixture-directory',
  'fixture-map',
] as const;

/**
 * Builds the enabled providers and *refuses* to enable one whose licence conditions the
 * operator has not satisfied. Google Places and Foursquare are intentionally not
 * implemented: their terms forbid persisting names/addresses (see docs/provider-terms-register.md).
 */
export function createProviders(config: ProviderFactoryConfig): ProviderSet {
  const providers: CompanyDiscoveryProvider[] = [];
  const skipped: SkippedProvider[] = [];

  for (const id of new Set(config.enabled)) {
    switch (id) {
      case 'overpass-osm':
        providers.push(
          new OverpassProvider({
            userAgent: config.userAgent,
            endpoint: config.overpass?.endpoint,
            minIntervalMs: config.overpass?.minIntervalMs,
            cache: config.overpass?.cache,
            fetchImpl: config.fetchImpl,
          }),
        );
        break;
      case 'brave-search': {
        const brave = config.brave;
        if (!brave?.apiKey) {
          skipped.push({ id, reason: 'BRAVE_SEARCH_API_KEY is not set' });
        } else if (!brave.storageRightsConfirmed) {
          skipped.push({
            id,
            reason:
              "Brave's terms bar storing results without a storage-rights plan; set BRAVE_SEARCH_STORAGE_RIGHTS=true only if your plan includes them",
          });
        } else {
          providers.push(
            new BraveSearchProvider({
              apiKey: brave.apiKey,
              requestsPerSecond: brave.requestsPerSecond,
              pagesPerQuery: brave.pagesPerQuery,
              fetchImpl: config.fetchImpl,
            }),
          );
        }
        break;
      }
      case 'fixture-directory':
      case 'fixture-map': {
        if (!config.allowFixtures) {
          skipped.push({
            id,
            reason: 'fixture providers are synthetic and disabled in production',
          });
          break;
        }
        const fixture = createFixtureProviders().find((provider) => provider.id === id);
        if (fixture) providers.push(fixture);
        break;
      }
      default:
        skipped.push({ id, reason: 'unknown provider id' });
    }
  }
  return { providers, skipped };
}
