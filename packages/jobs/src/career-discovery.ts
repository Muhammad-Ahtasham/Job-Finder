import {
  canonicalizeUrl,
  FetchError,
  parsePage,
  registrableDomain,
  type PageFetcher,
} from '@jobfinder/enrichment';
import { ATSDetectionService, type AtsDetection } from './ats-detection';
import { scoreCareerLink, scoreRecruitmentContent } from './career-signals';

export type CareerPageKind = 'ON_SITE' | 'ATS_HOSTED' | 'EXTERNAL_PORTAL';

export interface CareerPageCandidate {
  url: string;
  kind: CareerPageKind;
  /** 0..1, from link evidence AND page content. */
  confidence: number;
  signals: string[];
  /** Every ATS referenced by the page (itself, or embedded/linked from it). */
  detections: AtsDetection[];
  title?: string;
  fetched: boolean;
}

export interface CareerDiscoveryResult {
  candidates: CareerPageCandidate[];
  errors: { url: string; code: string; message: string; retryable: boolean }[];
  requests: number;
}

export interface CareerDiscoveryInput {
  /** Homepage of the verified official website. */
  homepageUrl: string;
  homepageHtml?: string;
  /** Pages already believed to be career pages (e.g. from website enrichment). */
  knownUrls?: string[];
  signal?: AbortSignal;
}

const WELL_KNOWN = [
  '/careers',
  '/career',
  '/jobs',
  '/join-us',
  '/work-with-us',
  '/join-our-team',
  '/vacancies',
];
const ACCEPT = 0.5;

/**
 * Finds recruitment pages and the ATS behind them. The URL only nominates a page; what
 * decides is the page itself: its recruitment wording, structured JobPosting data, posting-
 * shaped links and ATS embeds. So `/about/join` with a job list is accepted, and `/careers-
 * advice` that is a blog post is not.
 */
export class CareerPageDiscoveryService {
  constructor(
    private readonly options: {
      fetcher: PageFetcher;
      ats: ATSDetectionService;
      /** Hard cap on page fetches per discovery. */
      maxFetches?: number;
    },
  ) {}

  /** Recognise an ATS board from a URL alone (no network). */
  identifyUrl(url: string): AtsDetection | null {
    return this.options.ats.detectFromUrl(url);
  }

  async discover(input: CareerDiscoveryInput): Promise<CareerDiscoveryResult> {
    const { fetcher, ats } = this.options;
    const max = this.options.maxFetches ?? 6;
    const errors: CareerDiscoveryResult['errors'] = [];
    let requests = 0;
    const siteDomain = registrableDomain(input.homepageUrl);

    const fetchHtml = async (url: string): Promise<{ url: string; html: string } | undefined> => {
      if (requests >= max || input.signal?.aborted) return undefined;
      requests += 1;
      try {
        const r = await fetcher.fetchText(url, {
          allowedContentTypes: ['text/html', 'application/xhtml+xml'],
          signal: input.signal,
        });
        return { url: r.url, html: r.body };
      } catch (error) {
        if (error instanceof FetchError) {
          if (!(error.httpStatus === 404 || error.httpStatus === 410)) {
            errors.push({
              url,
              code: error.code,
              message: error.message,
              retryable: error.retryable,
            });
          }
        } else {
          errors.push({ url, code: 'UNEXPECTED', message: String(error), retryable: false });
        }
        return undefined;
      }
    };

    // ---- 1. nominate pages from the homepage's links, embeds and known URLs
    const home =
      input.homepageHtml !== undefined
        ? { url: input.homepageUrl, html: input.homepageHtml }
        : await fetchHtml(input.homepageUrl);
    const nominated = new Map<string, { score: number; signals: string[]; text: string }>();
    const nominate = (url: string, score: number, signals: string[], text = '') => {
      let key: string;
      try {
        key = canonicalizeUrl(url);
      } catch {
        return;
      }
      const prior = nominated.get(key);
      if (!prior || score > prior.score) nominated.set(key, { score, signals, text });
    };
    const detections = new Map<string, AtsDetection>();
    const remember = (list: AtsDetection[]) => {
      for (const d of list) detections.set(`${d.platform}:${d.board?.boardKey ?? d.url}`, d);
    };

    let homeParsed: ReturnType<typeof parsePage> | undefined;
    if (home) {
      homeParsed = parsePage(home.html, home.url);
      remember(
        ats.detectFromHtml(
          home.html,
          homeParsed.links.map((l) => l.url),
        ),
      );
      for (const link of homeParsed.links) {
        const domain = registrableDomain(link.url);
        const detection = ats.detectFromUrl(link.url, 'LINK');
        const { score, signals } = scoreCareerLink(link.url, link.text);
        if (detection) {
          // A link into an ATS is a strong nomination whatever its anchor says.
          nominate(
            link.url,
            Math.max(score, 0.7),
            ['links to ' + detection.platform, ...signals],
            link.text,
          );
        } else if (domain === siteDomain && score >= 0.35) {
          nominate(link.url, score, signals, link.text);
        } else if (
          domain !== siteDomain &&
          /careers?|jobs|join us|work with us|hiring/i.test(link.text) &&
          score >= 0.45
        ) {
          nominate(link.url, score, ['external ' + signals.join(', ')], link.text); // external portal
        }
      }
    }
    for (const url of input.knownUrls ?? [])
      nominate(url, 0.5, ['already identified as a careers page']);

    // ---- 2. nothing promising: probe the well-known paths (judged by content afterwards)
    if (![...nominated.values()].some((n) => n.score >= 0.5)) {
      for (const path of WELL_KNOWN)
        nominate(new URL(path, input.homepageUrl).href, 0.3, ['well-known path']);
    }

    // ---- 3. judge each nominee by its content
    const ranked = [...nominated.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 10);
    const candidates: CareerPageCandidate[] = [];
    const seenBoards = new Set<string>();

    for (const [url, nomination] of ranked) {
      const direct = ats.detectFromUrl(url);
      if (direct) {
        // The page IS an ATS board: nothing to fetch, the provider API will verify it.
        const key = `${direct.platform}:${direct.board?.boardKey ?? url}`;
        if (seenBoards.has(key)) continue;
        seenBoards.add(key);
        candidates.push({
          url,
          kind: 'ATS_HOSTED',
          confidence: Math.max(0.8, nomination.score),
          signals: [...nomination.signals, `hosted on ${direct.platform}`],
          detections: [direct],
          fetched: false,
        });
        continue;
      }
      if (candidates.filter((c) => c.fetched).length >= 4) continue;
      const page = await fetchHtml(url);
      if (!page) continue;
      const parsed = parsePage(page.html, page.url);
      const content = scoreRecruitmentContent(page.html, parsed);
      const pageDetections = ats.detectFromHtml(
        page.html,
        parsed.links.map((l) => l.url),
      );
      remember(pageDetections);

      // Content decides; the link evidence only nudges. A strong embed is decisive.
      const confidence = Math.min(
        1,
        Number(
          (
            content.score * 0.65 +
            nomination.score * 0.35 +
            (pageDetections.length ? 0.25 : 0)
          ).toFixed(2),
        ),
      );
      if (confidence < ACCEPT || (content.score < 0.3 && pageDetections.length === 0)) continue;
      candidates.push({
        url: page.url,
        kind: registrableDomain(page.url) === siteDomain ? 'ON_SITE' : 'EXTERNAL_PORTAL',
        confidence,
        signals: [
          ...nomination.signals,
          ...content.signals,
          ...pageDetections.map((d) => `references ${d.platform}`),
        ],
        detections: pageDetections,
        title: parsed.title || undefined,
        fetched: true,
      });
    }

    // The homepage itself may embed a board (a careers widget on the landing page).
    if (home && homeParsed) {
      for (const d of detections.values()) {
        const key = `${d.platform}:${d.board?.boardKey ?? d.url}`;
        if (
          seenBoards.has(key) ||
          candidates.some((c) =>
            c.detections.some(
              (x) => x.board?.boardKey === d.board?.boardKey && x.platform === d.platform,
            ),
          )
        )
          continue;
        candidates.push({
          url: d.url,
          kind: d.supported || registrableDomain(d.url) !== siteDomain ? 'ATS_HOSTED' : 'ON_SITE',
          confidence: 0.75,
          signals: [`${d.platform} ${d.evidence.toLowerCase()} found on the homepage`],
          detections: [d],
          fetched: false,
        });
      }
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    return { candidates, errors, requests };
  }
}
