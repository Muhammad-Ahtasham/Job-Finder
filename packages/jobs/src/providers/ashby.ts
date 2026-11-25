import {
  cleanLocation,
  cleanTitle,
  inferWorkplaceFromLocation,
  isSafeBoardKey,
  mapEmploymentType,
  mapWorkplaceType,
  parseDate,
  plainText,
  htmlToText,
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

const API = 'https://api.ashbyhq.com/posting-api/job-board';

/**
 * Ashby Public Job Posting API — https://developers.ashbyhq.com/docs/public-job-posting-api
 *   GET https://api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}
 * `JOB_BOARD_NAME` is the path segment of `jobs.ashbyhq.com/{name}`. One response lists every
 * published job (no pagination). Postings with `isListed: false` are not on the public board and
 * are skipped. Reading only.
 */
export class AshbyProvider implements JobDiscoveryProvider {
  readonly id = 'ashby';
  readonly displayName = 'Ashby Public Job Posting API';
  readonly terms = {
    docsUrl: 'https://developers.ashbyhq.com/docs/public-job-posting-api',
    reviewedAt: '2026-11-25',
    notes: 'Public, unauthenticated GET. Compensation (includeCompensation) is not requested.',
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
    let name: string | undefined;
    if (host === 'jobs.ashbyhq.com') name = segments[0];
    else if (
      host === 'api.ashbyhq.com' &&
      segments[0] === 'posting-api' &&
      segments[1] === 'job-board'
    ) {
      name = segments[2];
    }
    if (!name || !isSafeBoardKey(name)) return null;
    return { providerId: this.id, boardKey: name, boardUrl: `https://jobs.ashbyhq.com/${name}` };
  }

  async fetchJobs(board: BoardRef, context: JobProviderContext = {}): Promise<JobFetchResult> {
    if (!isSafeBoardKey(board.boardKey)) {
      return {
        outcome: 'FAILED',
        error: { code: 'INVALID_BOARD', message: 'Invalid Ashby board name', retryable: false },
        jobs: [],
        pagesFetched: 0,
      };
    }
    try {
      const body = asRecord(
        await this.client.getJson(`${API}/${encodeURIComponent(board.boardKey)}`, context.signal),
      );
      if (!body || !Array.isArray(body.jobs)) throw badShape('Ashby jobs list');

      const jobs: NormalizedJob[] = [];
      const seen = new Set<string>();
      let listed = 0;
      for (const raw of body.jobs) {
        if (asRecord(raw)?.isListed === false) continue;
        listed += 1;
        const job = this.normalize(board, raw);
        if (job && !seen.has(job.externalId)) {
          seen.add(job.externalId);
          jobs.push(job);
        }
      }
      if (listed > 0 && jobs.length === 0) throw badShape('no job could be read');
      if (listed === 0) {
        return {
          outcome: 'NO_OPENINGS',
          pagesFetched: 1,
          authoritative: true,
          evidence: 'Ashby API returned 0 listed jobs',
        };
      }
      return { outcome: 'JOBS', jobs, pagesFetched: 1, authoritative: jobs.length === listed };
    } catch (error) {
      if (error instanceof ApiRequestError) {
        return { outcome: 'FAILED', error: error.detail, jobs: [], pagesFetched: 0 };
      }
      throw error;
    }
  }

  private normalize(board: BoardRef, raw: unknown): NormalizedJob | null {
    const r = asRecord(raw);
    const title = cleanTitle(r?.title);
    const jobUrl = asString(r?.jobUrl);
    if (!r || !title || !jobUrl) return null;
    // `id` is returned by the live API; the documented sample omits it, so fall back to the URL's last segment.
    const externalId = asString(r.id) ?? jobUrl.split('/').filter(Boolean).pop() ?? null;
    if (!externalId) return null;

    const location = cleanLocation(r.location);
    const secondary = Array.isArray(r.secondaryLocations)
      ? r.secondaryLocations
          .map((s) => cleanLocation(asRecord(s)?.location))
          .filter((l): l is string => !!l)
      : [];
    const stated = mapWorkplaceType(asString(r.workplaceType));
    return {
      providerId: this.id,
      boardKey: board.boardKey,
      externalId,
      title,
      description:
        plainText(asString(r.descriptionPlain)) ?? htmlToText(asString(r.descriptionHtml)),
      location,
      locations: [...new Set([...(location ? [location] : []), ...secondary])],
      department: asString(r.department) ?? asString(r.team),
      employmentType: mapEmploymentType(asString(r.employmentType)),
      workplaceType:
        stated !== 'UNKNOWN'
          ? stated
          : r.isRemote === true
            ? 'REMOTE'
            : inferWorkplaceFromLocation(location),
      applicationUrl: asString(r.applyUrl) ?? jobUrl,
      sourceUrl: jobUrl,
      publishedAt: parseDate(r.publishedAt),
      extraction: 'API',
    };
  }
}
