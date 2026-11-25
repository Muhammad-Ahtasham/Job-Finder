import {
  cleanLocation,
  cleanTitle,
  inferWorkplaceFromLocation,
  isSafeBoardKey,
  mapEmploymentType,
  mapWorkplaceType,
  parseDate,
  plainText,
} from '../normalize';
import type {
  BoardRef,
  JobDiscoveryProvider,
  JobFetchResult,
  JobProviderContext,
  NormalizedJob,
} from '../types';
import {
  ApiClient,
  ApiRequestError,
  asRecord,
  asString,
  badShape,
  type ApiClientOptions,
} from './api-client';

const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const INSTANCES = {
  global: { api: 'https://api.lever.co/v0/postings', hosts: ['jobs.lever.co', 'api.lever.co'] },
  eu: {
    api: 'https://api.eu.lever.co/v0/postings',
    hosts: ['jobs.eu.lever.co', 'api.eu.lever.co'],
  },
} as const;

/**
 * Lever Postings API — https://github.com/lever/postings-api
 *   GET https://api.lever.co/v0/postings/{site}?mode=json&skip={n}&limit={n}
 * (EU instance: api.eu.lever.co). The list is a bare JSON array, paged with skip/limit; a page
 * shorter than `limit` is the last one. Only published postings are returned. Reading only —
 * the application POST endpoint is never called.
 */
export class LeverProvider implements JobDiscoveryProvider {
  readonly id = 'lever';
  readonly displayName = 'Lever Postings API';
  readonly terms = {
    docsUrl: 'https://github.com/lever/postings-api',
    reviewedAt: '2026-11-25',
    notes: 'Published postings are public. Global and EU instances are separate hosts.',
  };
  private readonly client: ApiClient;

  constructor(options: ApiClientOptions) {
    this.client = new ApiClient(options);
  }

  identify(rawUrl: string): BoardRef | null {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split('/').filter(Boolean);
    for (const [region, instance] of Object.entries(INSTANCES) as [
      'global' | 'eu',
      (typeof INSTANCES)[keyof typeof INSTANCES],
    ][]) {
      if (!(instance.hosts as readonly string[]).includes(host)) continue;
      const site =
        host.startsWith('api.') && segments[0] === 'v0' && segments[1] === 'postings'
          ? segments[2]
          : host.startsWith('jobs.')
            ? segments[0]
            : undefined;
      if (!site || !isSafeBoardKey(site)) return null;
      return {
        providerId: this.id,
        boardKey: site,
        boardUrl: `https://${region === 'eu' ? 'jobs.eu.lever.co' : 'jobs.lever.co'}/${site}`,
        ...(region === 'eu' ? { region: 'eu' as const } : {}),
      };
    }
    return null;
  }

  async fetchJobs(board: BoardRef, context: JobProviderContext = {}): Promise<JobFetchResult> {
    if (!isSafeBoardKey(board.boardKey)) {
      return {
        outcome: 'FAILED',
        error: { code: 'INVALID_BOARD', message: 'Invalid Lever site name', retryable: false },
        jobs: [],
        pagesFetched: 0,
      };
    }
    const base = `${board.region === 'eu' ? INSTANCES.eu.api : INSTANCES.global.api}/${encodeURIComponent(board.boardKey)}`;
    const jobs: NormalizedJob[] = [];
    const seen = new Set<string>();
    let pages = 0;
    let rawCount = 0;

    try {
      for (let skip = 0; pages < MAX_PAGES; skip += PAGE_SIZE) {
        const page = await this.client.getJson(
          `${base}?mode=json&skip=${skip}&limit=${PAGE_SIZE}`,
          context.signal,
        );
        if (!Array.isArray(page)) throw badShape('Lever postings list');
        pages += 1;
        rawCount += page.length;
        for (const raw of page) {
          const job = this.normalize(board, raw);
          if (job && !seen.has(job.externalId)) {
            seen.add(job.externalId);
            jobs.push(job);
          }
        }
        if (page.length < PAGE_SIZE) {
          if (rawCount > 0 && jobs.length === 0) throw badShape('no posting could be read');
          if (rawCount === 0) {
            return {
              outcome: 'NO_OPENINGS',
              pagesFetched: pages,
              authoritative: true,
              evidence: 'Lever API returned 0 postings',
            };
          }
          return {
            outcome: 'JOBS',
            jobs,
            pagesFetched: pages,
            authoritative: jobs.length === rawCount,
          };
        }
      }
      // A board with thousands of postings: what we have is real but is not the whole list.
      return { outcome: 'JOBS', jobs, pagesFetched: pages, authoritative: false };
    } catch (error) {
      if (error instanceof ApiRequestError) {
        return { outcome: 'FAILED', error: error.detail, jobs, pagesFetched: pages };
      }
      throw error;
    }
  }

  private normalize(board: BoardRef, raw: unknown): NormalizedJob | null {
    const r = asRecord(raw);
    const id = asString(r?.id);
    const title = cleanTitle(r?.text);
    const hostedUrl = asString(r?.hostedUrl);
    if (!r || !id || !title || !hostedUrl) return null;

    const categories = asRecord(r.categories) ?? {};
    const all = Array.isArray(categories.allLocations)
      ? categories.allLocations.map(cleanLocation).filter((l): l is string => !!l)
      : [];
    const location = cleanLocation(categories.location) ?? all[0] ?? null;
    const locations = [...new Set([...(location ? [location] : []), ...all])];

    const lists = Array.isArray(r.lists)
      ? r.lists
          .map((l) => asRecord(l))
          .filter((l): l is Record<string, unknown> => !!l)
          .map((l) => `${asString(l.text) ?? ''}\n${plainFromHtml(asString(l.content))}`)
      : [];
    const description = plainText(
      [asString(r.descriptionPlain), ...lists, asString(r.additionalPlain)]
        .filter(Boolean)
        .join('\n\n'),
    );

    const stated = mapWorkplaceType(asString(r.workplaceType));
    return {
      providerId: this.id,
      boardKey: board.boardKey,
      externalId: id,
      title,
      description,
      location,
      locations,
      department: asString(categories.department) ?? asString(categories.team),
      employmentType: mapEmploymentType(asString(categories.commitment)),
      workplaceType: stated !== 'UNKNOWN' ? stated : inferWorkplaceFromLocation(location),
      applicationUrl: asString(r.applyUrl) ?? hostedUrl,
      sourceUrl: hostedUrl,
      publishedAt: parseDate(r.createdAt),
      extraction: 'API',
    };
  }
}

function plainFromHtml(html: string | null): string {
  return (html ?? '')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}
