import { FetchError, type PageFetcher } from '@jobfinder/enrichment';
import { groundJobsToNormalized } from '../generic-ai';
import { extractJobsFromHtml } from '../generic-extractor';
import { scoreRecruitmentContent } from '../career-signals';
import { parsePage } from '@jobfinder/enrichment';
import type {
  BoardRef,
  JobDiscoveryProvider,
  JobFetchResult,
  JobProviderContext,
  NormalizedJob,
} from '../types';

const MAX_PAGES = 5;
const MAX_JOBS = 500;

/**
 * Fallback for career pages that are not on a supported ATS. Fetches through the same
 * SSRF-guarded, robots-aware, rate-limited fetcher as the website crawler.
 *
 * Honesty rules: a page that fetched but yielded nothing is INCONCLUSIVE, not "no openings";
 * only an explicit statement on the page ("no current openings") yields NO_OPENINGS; and a
 * failed or robots-blocked fetch is FAILED. Generic results are never authoritative, so they
 * can never close a job.
 */
export class GenericHtmlJobProvider implements JobDiscoveryProvider {
  readonly id = 'generic-html';
  readonly displayName = 'Generic career page';
  readonly terms = {
    docsUrl: 'https://schema.org/JobPosting',
    reviewedAt: '2026-11-25',
    notes:
      'Public HTML only; robots.txt obeyed; structured data first, heuristics second, AI last.',
  };

  constructor(private readonly fetcher: PageFetcher) {}

  /** Generic pages are chosen by discovery, never recognised from a URL. */
  identify(): BoardRef | null {
    return null;
  }

  async fetchJobs(board: BoardRef, context: JobProviderContext = {}): Promise<JobFetchResult> {
    const jobs: NormalizedJob[] = [];
    const seen = new Set<string>();
    let url: string | undefined = board.boardUrl;
    let pages = 0;
    let statedNone = false;
    let lastText = '';
    let lastLinks: { text: string; url: string }[] = [];
    let recruitment = 0;

    while (url && pages < MAX_PAGES && jobs.length < MAX_JOBS) {
      let fetched;
      try {
        fetched = await this.fetcher.fetchText(url, {
          allowedContentTypes: ['text/html', 'application/xhtml+xml'],
          signal: context.signal,
        });
      } catch (error) {
        const e = error instanceof FetchError ? error : undefined;
        return {
          outcome: 'FAILED',
          error: {
            code: e?.code ?? 'UNEXPECTED',
            message: e?.message ?? (error instanceof Error ? error.message : 'Unexpected error'),
            retryable: e?.retryable ?? false,
            httpStatus: e?.httpStatus,
          },
          jobs,
          pagesFetched: pages,
        };
      }
      pages += 1;
      const extraction = extractJobsFromHtml(fetched.body, fetched.url, board);
      for (const job of extraction.jobs) {
        if (!seen.has(job.externalId)) {
          seen.add(job.externalId);
          jobs.push(job);
        }
      }
      statedNone ||= extraction.statesNoOpenings;
      lastText = extraction.text;
      lastLinks = extraction.links;
      if (pages === 1)
        recruitment = scoreRecruitmentContent(
          fetched.body,
          parsePage(fetched.body, fetched.url),
        ).score;

      // Follow pagination only within the same site and only while it keeps yielding jobs.
      const next = extraction.nextPageUrl;
      url = next && sameHost(next, board.boardUrl) && extraction.jobs.length > 0 ? next : undefined;
    }

    if (jobs.length > 0)
      return { outcome: 'JOBS', jobs, pagesFetched: pages, authoritative: false };
    if (statedNone) {
      return {
        outcome: 'NO_OPENINGS',
        pagesFetched: pages,
        authoritative: false,
        evidence: 'The page states there are no current openings',
      };
    }

    // Nothing deterministic found: ask the AI only if this really looks like a recruitment page.
    if (context.ai && recruitment >= 0.4 && lastText) {
      const proposed = await context.ai.extractJobs({
        pageUrl: board.boardUrl,
        text: lastText,
        links: lastLinks,
      });
      const aiJobs = groundJobsToNormalized(proposed, board);
      if (aiJobs.length > 0)
        return { outcome: 'JOBS', jobs: aiJobs, pagesFetched: pages, authoritative: false };
    }
    return {
      outcome: 'INCONCLUSIVE',
      reason:
        'The page was read but no job listings could be extracted and it does not say there are none',
      pagesFetched: pages,
    };
  }
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}
