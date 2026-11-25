import {
  cleanLocation,
  cleanTitle,
  decodeEntitiesOnce,
  htmlToText,
  inferWorkplaceFromLocation,
  isSafeBoardKey,
  parseDate,
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

const API = 'https://boards-api.greenhouse.io/v1/boards';
const BOARD_HOSTS = new Set([
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'boards.eu.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

/**
 * Greenhouse Job Board API — https://developers.greenhouse.io/job-board.html
 *   GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true
 * The board token is the path segment of `boards.greenhouse.io/{token}`. The list endpoint
 * returns every published job in one response (no pagination); `meta.total` lets us detect a
 * truncated answer. Only reading — the application POST endpoint is never called.
 */
export class GreenhouseProvider implements JobDiscoveryProvider {
  readonly id = 'greenhouse';
  readonly displayName = 'Greenhouse Job Board API';
  readonly terms = {
    docsUrl: 'https://developers.greenhouse.io/job-board.html',
    reviewedAt: '2026-11-25',
    notes: 'GET endpoints are public and unauthenticated; may be rate limited.',
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
    let token: string | undefined;
    if (BOARD_HOSTS.has(host)) {
      token = segments[0] === 'embed' ? (url.searchParams.get('for') ?? undefined) : segments[0];
    } else if (
      host === 'boards-api.greenhouse.io' &&
      segments[0] === 'v1' &&
      segments[1] === 'boards'
    ) {
      token = segments[2];
    }
    if (!token || !isSafeBoardKey(token)) return null;
    return {
      providerId: this.id,
      boardKey: token.toLowerCase(),
      boardUrl: `https://boards.greenhouse.io/${token.toLowerCase()}`,
    };
  }

  async fetchJobs(board: BoardRef, context: JobProviderContext = {}): Promise<JobFetchResult> {
    if (!isSafeBoardKey(board.boardKey)) {
      return failed('INVALID_BOARD', 'Invalid Greenhouse board token');
    }
    try {
      const body = asRecord(
        await this.client.getJson(
          `${API}/${encodeURIComponent(board.boardKey)}/jobs?content=true`,
          context.signal,
        ),
      );
      if (!body || !Array.isArray(body.jobs)) throw badShape('Greenhouse jobs list');

      const jobs: NormalizedJob[] = [];
      const seen = new Set<string>();
      for (const raw of body.jobs) {
        const job = this.normalize(board, raw);
        if (job && !seen.has(job.externalId)) {
          seen.add(job.externalId);
          jobs.push(job);
        }
      }
      const total = asRecord(body.meta)?.total;
      // If the API says there are more jobs than it returned, do not treat the list as complete.
      const complete = typeof total !== 'number' || body.jobs.length >= total;
      if (body.jobs.length > 0 && jobs.length === 0) throw badShape('no job could be read');
      const dropped = body.jobs.length - jobs.length; // unreadable or duplicate entries
      if (jobs.length === 0 && body.jobs.length === 0 && complete) {
        return {
          outcome: 'NO_OPENINGS',
          pagesFetched: 1,
          authoritative: true,
          evidence: 'Greenhouse API returned 0 jobs',
        };
      }
      return { outcome: 'JOBS', jobs, pagesFetched: 1, authoritative: complete && dropped === 0 };
    } catch (error) {
      if (error instanceof ApiRequestError) {
        return { outcome: 'FAILED', error: error.detail, jobs: [], pagesFetched: 0 };
      }
      throw error;
    }
  }

  private normalize(board: BoardRef, raw: unknown): NormalizedJob | null {
    const r = asRecord(raw);
    if (!r || (typeof r.id !== 'number' && typeof r.id !== 'string')) return null;
    const title = cleanTitle(r.title);
    const url = asString(r.absolute_url);
    if (!title || !url) return null;
    const location = cleanLocation(asRecord(r.location)?.name);
    const department = Array.isArray(r.departments)
      ? asString(asRecord(r.departments[0])?.name)
      : null;
    const content = asString(r.content);
    return {
      providerId: this.id,
      boardKey: board.boardKey,
      externalId: String(r.id),
      title,
      description: content ? htmlToText(decodeEntitiesOnce(content)) : null,
      location,
      locations: location ? [location] : [],
      department,
      employmentType: 'UNKNOWN', // the Job Board API has no employment-type field
      workplaceType: inferWorkplaceFromLocation(location),
      applicationUrl: url,
      sourceUrl: url,
      publishedAt: parseDate(r.first_published),
      extraction: 'API',
    };
  }
}

const failed = (code: string, message: string): JobFetchResult => ({
  outcome: 'FAILED',
  error: { code, message, retryable: false },
  jobs: [],
  pagesFetched: 0,
});
