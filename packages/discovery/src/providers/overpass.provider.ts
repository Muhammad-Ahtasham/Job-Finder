import { createHash } from 'node:crypto';
import { ProviderError } from '../errors';
import { fetchJson, type FetchLike } from '../http';
import { foldText } from '../normalization/text';
import type {
  CompanyCandidate,
  CompanyDiscoveryProvider,
  DiscoveryPage,
  DiscoveryProjectInput,
  DiscoveryQuery,
  ProviderRateLimit,
  ProviderTerms,
  SearchContext,
} from '../types';

export interface ProviderCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface OverpassOptions {
  /** Prefer a self-hosted Overpass built from a Geofabrik extract for production. */
  endpoint?: string;
  userAgent: string;
  /** Minimum gap between requests; the public instance asks for gentle, serial use. */
  minIntervalMs?: number;
  maxElements?: number;
  cache?: ProviderCache;
  cacheTtlSeconds?: number;
  fetchImpl?: FetchLike;
}

interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

const SOFTWARE_INDUSTRY =
  /soft|\bit\b|information tech|technolog|saas|digital|web|app|cloud|data|cyber|\bai\b/i;
/** Names of otherwise untagged `office=company` features that suggest IT work. */
const IT_NAME_REGEX =
  'soft|tech|system|solution|digital|data|cloud|labs|apps|info|net|cyber|logic|ware|byte';

/**
 * OpenStreetMap-derived discovery through the Overpass API (ODbL data).
 *
 * POLICY: city-scoped, a handful of queries per run, cached, serialized with a minimum
 * interval and an identifying User-Agent — the opposite of systematic bulk harvesting.
 * Public Nominatim is never used. For heavier use, point `endpoint` at your own Overpass
 * instance loaded from a Geofabrik extract. OSM coverage of businesses in many cities is
 * thin; expect modest recall.
 */
export class OverpassProvider implements CompanyDiscoveryProvider {
  readonly id = 'overpass-osm';
  readonly displayName = 'OpenStreetMap (Overpass)';
  readonly terms: ProviderTerms = {
    termsUrl: 'https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances',
    reviewedAt: '2026-11-24',
    storage: 'PERMANENT',
    attribution: '© OpenStreetMap contributors (ODbL 1.0)',
    bulkAllowed: false,
    notes:
      'ODbL: attribute and keep share-alike in mind for derived databases. Public instance: ≤10k queries/day, identify the app, no parallel scripts, pause 30s after 429/406.',
  };
  readonly rateLimit: ProviderRateLimit;
  /** Every query is bounded by the city's administrative area. */
  readonly cityScoped = true;

  private readonly endpoint: string;

  constructor(private readonly options: OverpassOptions) {
    this.endpoint = options.endpoint ?? 'https://overpass-api.de/api/interpreter';
    this.rateLimit = { maxRequests: 1, perMs: options.minIntervalMs ?? 5000, concurrency: 1 };
  }

  planQueries(project: DiscoveryProjectInput): DiscoveryQuery[] {
    const queries: DiscoveryQuery[] = [];
    if (SOFTWARE_INDUSTRY.test(project.industry)) {
      queries.push({ kind: 'AREA', key: 'area:industry', project });
    }
    for (const keyword of project.keywords) {
      if (sanitizeWords(keyword).length > 0) {
        queries.push({ kind: 'KEYWORD', key: `kw:${foldText(keyword)}`, keyword, project });
      }
    }
    return queries;
  }

  async search(
    query: DiscoveryQuery,
    _cursor: string | undefined,
    context?: SearchContext,
  ): Promise<DiscoveryPage> {
    const areaIds = await this.resolveAreaIds(query.project, context);
    const ql = this.buildQuery(query, areaIds);
    const json = await this.run(ql, context);
    const elements = (json as { elements?: unknown }).elements;
    const remark = (json as { remark?: unknown }).remark;
    if (typeof remark === 'string' && /runtime error|timed out|out of memory/i.test(remark)) {
      throw new ProviderError(`Overpass: ${remark}`, 'UNAVAILABLE', { retryable: true });
    }
    if (!Array.isArray(elements)) {
      throw new ProviderError('Unexpected Overpass response shape', 'BAD_RESPONSE', {
        retryable: false,
      });
    }

    const retrievedAt = new Date();
    const candidates: CompanyCandidate[] = [];
    let filtered = 0;
    for (const element of elements as OverpassElement[]) {
      const candidate = this.toCandidate(element, query, retrievedAt);
      if (candidate) candidates.push(candidate);
      else filtered += 1;
    }
    return { candidates, filtered };
  }

  /**
   * Find the administrative relation(s) that make up the project's city. OSM rarely has a
   * relation named exactly after a city (Lahore is "Lahore District" + "Lahore City Tehsil",
   * with the Urdu name in `name` and English only in `name:en`), so both name keys and the
   * usual administrative suffixes are accepted. An unresolved city is an explicit,
   * non-retryable error, never a silent "0 results". Responses are cached (ids are stable).
   */
  async resolveAreaIds(project: DiscoveryProjectInput, context?: SearchContext): Promise<number[]> {
    const json = (await this.run(this.buildAreaQuery(project), context)) as { elements?: unknown };
    const ids = Array.isArray(json.elements)
      ? (json.elements as OverpassElement[])
          .map((element) => element.id)
          .filter((id): id is number => typeof id === 'number')
      : [];
    if (ids.length === 0) {
      throw new ProviderError(
        `City "${project.city}" (${project.country}) was not found in OpenStreetMap administrative boundaries; check the spelling or use the English name`,
        'BAD_REQUEST',
        { retryable: false },
      );
    }
    return [...new Set(ids)].slice(0, 10);
  }

  /** Exposed for tests. Interpolated values are sanitized to letters, digits and spaces. */
  buildAreaQuery(project: DiscoveryProjectInput): string {
    const country = project.country.toUpperCase().replace(/[^A-Z]/g, '');
    const city = sanitizeWords(project.city).join(' ');
    if (!country || !city) {
      throw new ProviderError('Project needs a country and city', 'BAD_REQUEST', {
        retryable: false,
      });
    }
    const cityRegex = city.split(' ').join('[ -]?');
    return [
      '[out:json][timeout:60];',
      `area["ISO3166-1"="${country}"]["boundary"="administrative"]["admin_level"="2"]->.c;`,
      `rel(area.c)["boundary"="administrative"]["admin_level"~"^[5-9]$"][~"^name(:en)?$"~"^${cityRegex}( (city|district|municipality|municipal corporation|metropolitan corporation|metropolis|town))?( tehsil)?$",i];`,
      'out ids;',
    ].join('\n');
  }

  /** Exposed for tests. `areaIds` come from resolveAreaIds. */
  buildQuery(query: DiscoveryQuery, areaIds: number[]): string {
    const maxElements = this.options.maxElements ?? 400;
    const ids = areaIds.filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) {
      throw new ProviderError('No area to search', 'BAD_REQUEST', { retryable: false });
    }

    // Overpass QL needs the `id:` prefix for an id list: `rel(id:1,2)`; `rel(1,2)` is a syntax error.
    const header = ['[out:json][timeout:60];', `rel(id:${ids.join(',')});`, 'map_to_area->.a;'];

    let body: string[];
    if (query.kind === 'AREA') {
      body = [
        'nwr["office"="it"]["name"](area.a);',
        `nwr["office"="company"]["name"~"${IT_NAME_REGEX}",i](area.a);`,
      ];
    } else {
      const words = sanitizeWords(query.keyword ?? '');
      if (words.length === 0) {
        throw new ProviderError('Keyword has no searchable characters', 'BAD_REQUEST', {
          retryable: false,
        });
      }
      body = [`nwr["office"]["name"~"${words.join('[ -]?')}",i](area.a);`];
    }
    return [...header, '(', ...body, ');', `out center tags ${maxElements};`].join('\n');
  }

  private async run(ql: string, context?: SearchContext): Promise<unknown> {
    const cacheKey = `jf:cache:overpass:${createHash('sha256')
      .update(this.endpoint + ql)
      .digest('hex')}`;
    const cached = await this.options.cache?.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        /* fall through to a live request */
      }
    }

    const json = await fetchJson(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': this.options.userAgent,
      },
      body: `data=${encodeURIComponent(ql)}`,
      timeoutMs: 90_000,
      signal: context?.signal,
      fetchImpl: this.options.fetchImpl,
      // The public instance asks clients to pause 30 s after a 429/406.
      defaultRetryAfterMs: 30_000,
    });

    // Only successful, well-formed responses are cached (24 h by default).
    if (Array.isArray((json as { elements?: unknown }).elements)) {
      await this.options.cache
        ?.set(cacheKey, JSON.stringify(json), this.options.cacheTtlSeconds ?? 86_400)
        .catch(() => undefined);
    }
    return json;
  }

  private toCandidate(
    element: OverpassElement,
    query: DiscoveryQuery,
    retrievedAt: Date,
  ): CompanyCandidate | undefined {
    const tags = element.tags ?? {};
    const name = tags.name?.trim();
    if (!name || !element.type || typeof element.id !== 'number') return undefined;
    if (
      tags['disused'] ||
      tags['abandoned'] ||
      tags['disused:office'] ||
      tags['abandoned:office']
    ) {
      return undefined;
    }

    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
    const line = [street, tags['addr:suburb'], tags['addr:neighbourhood']]
      .filter(Boolean)
      .join(', ');
    const phone = tags.phone ?? tags['contact:phone'];

    const registrationNumbers: { scheme: string; value: string }[] = [];
    if (tags['ref:vatin']) registrationNumbers.push({ scheme: 'VATIN', value: tags['ref:vatin'] });
    if (tags['ref:ntn']) registrationNumbers.push({ scheme: 'NTN', value: tags['ref:ntn'] });

    return {
      providerId: this.id,
      externalId: `${element.type}/${element.id}`,
      name,
      nameConfidence: 'HIGH',
      websiteUrl: tags.website ?? tags['contact:website'] ?? tags.url,
      description: tags.description,
      address: {
        line: line || undefined,
        city: tags['addr:city'],
        region: tags['addr:state'] ?? tags['addr:province'],
        postalCode: tags['addr:postcode'],
        country: tags['addr:country'],
      },
      coordinates:
        typeof lat === 'number' && typeof lon === 'number' ? { lat, lng: lon } : undefined,
      phones: phone ? [phone] : undefined,
      registrationNumbers: registrationNumbers.length ? registrationNumbers : undefined,
      sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      matchedKeyword: query.keyword,
      retrievedAt,
      raw: {
        osm: `${element.type}/${element.id}`,
        tags: pick(tags, [
          'name',
          'office',
          'website',
          'contact:website',
          'phone',
          'contact:phone',
          'description',
        ]),
      },
    };
  }
}

/** Letters/digits only (any script), so values are safe inside Overpass QL string literals. */
export function sanitizeWords(input: string): string[] {
  return input
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
}

function pick(source: Record<string, string>, keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) if (source[key]) result[key] = source[key]!;
  return result;
}
