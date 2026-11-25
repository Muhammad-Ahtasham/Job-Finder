export * from './types';
export * from './errors';
export { fetchJson, type FetchLike } from './http';
export {
  DefaultCompanyNormalizationService,
  countryNameOf,
  isValidCountryCode,
} from './normalization/company-normalization.service';
export { foldText, tokenize, stripLegalSuffixes, removeGenericWords } from './normalization/text';
export { normalizeWebsite, isAggregatorDomain } from './normalization/website';
export {
  DefaultCompanyDeduplicationService,
  DEDUPE_THRESHOLDS,
  nameSimilarity,
} from './dedupe/company-deduplication.service';
export { jaroWinkler } from './dedupe/similarity';
export { BraveSearchProvider, nameFromTitle } from './providers/brave-search.provider';
export { FixtureProvider, createFixtureProviders } from './providers/fixture.provider';
export { OverpassProvider, sanitizeWords, type ProviderCache } from './providers/overpass.provider';
export {
  createProviders,
  KNOWN_PROVIDER_IDS,
  type ProviderFactoryConfig,
  type ProviderSet,
  type SkippedProvider,
} from './providers/factory';

/** Unordered pair key for match reviews: one review per pair regardless of direction. */
export const pairKeyOf = (a: string, b: string): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
