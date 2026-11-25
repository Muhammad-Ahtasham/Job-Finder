import { parse } from 'tldts';
import type { PageType } from './types';

export interface PageClassification {
  type: PageType;
  confidence: number;
  /** Several types matched with similar strength: worth a second opinion. */
  ambiguous: boolean;
  signals: string[];
}

type ClassifiedType = Exclude<PageType, 'HOMEPAGE' | 'OTHER'>;

/** First/last-segment keywords. Matching is on whole path segments, never substrings. */
const PATH_KEYWORDS: Record<ClassifiedType, string[]> = {
  CAREERS: [
    'careers',
    'career',
    'join-us',
    'joinus',
    'join-our-team',
    'join-the-team',
    'work-with-us',
    'work-for-us',
    'workwithus',
    'opportunities',
    'hiring',
    'we-are-hiring',
    'were-hiring',
    'life-at-us',
  ],
  JOBS: [
    'jobs',
    'job',
    'job-openings',
    'openings',
    'open-positions',
    'open-roles',
    'positions',
    'vacancies',
    'vacancy',
    'current-openings',
    'job-listings',
    'job-opportunities',
  ],
  ABOUT: [
    'about',
    'about-us',
    'aboutus',
    'company',
    'who-we-are',
    'our-story',
    'our-company',
    'about-company',
  ],
  CONTACT: [
    'contact',
    'contact-us',
    'contactus',
    'get-in-touch',
    'reach-us',
    'connect',
    'contacts',
  ],
  TEAM: [
    'team',
    'our-team',
    'the-team',
    'leadership',
    'management',
    'meet-the-team',
    'people',
    'our-people',
  ],
};

const ANCHOR_PATTERNS: Record<ClassifiedType, RegExp> = {
  CAREERS:
    /^(careers?|join (us|our team|the team)|work (with|for) us|we(?:'|’)?re hiring|we are hiring|opportunities)$/i,
  JOBS: /^((current |open |latest )?(jobs|job openings|openings|positions|vacancies|roles)|open (positions|roles)|view (all )?(jobs|openings))$/i,
  ABOUT: /^(about( us| company)?|who we are|our (story|company))$/i,
  CONTACT: /^(contact( us)?|get in touch|reach us|contact information)$/i,
  TEAM: /^((our|the|meet the) team|leadership|management|our people|people)$/i,
};

/** Order matters on ties: CAREERS beats JOBS beats the rest. */
const ORDER: ClassifiedType[] = ['CAREERS', 'JOBS', 'CONTACT', 'ABOUT', 'TEAM'];
const LOCALE = /^[a-z]{2}(-[a-z]{2})?$/;

function segmentsOf(url: URL): string[] {
  return url.pathname
    .toLowerCase()
    .replace(/\.(html?|php|aspx?)$/i, '')
    .split('/')
    .filter(Boolean);
}

/**
 * Deterministic page typing from the URL path and the anchor text that linked to it.
 * `ambiguous` is true when evidence is weak or conflicting; the caller may then consult the
 * optional AI assistant. A path such as /careers/senior-engineer is a posting, not the
 * careers page, and is left as OTHER.
 */
export function classifyPage(
  rawUrl: string,
  anchorText?: string,
  title?: string,
): PageClassification {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { type: 'OTHER', confidence: 0, ambiguous: false, signals: ['invalid URL'] };
  }
  const segments = segmentsOf(url);
  if (segments.length === 0) {
    return { type: 'HOMEPAGE', confidence: 1, ambiguous: false, signals: ['root path'] };
  }
  const meaningful = segments[0] && LOCALE.test(segments[0]) ? segments.slice(1) : segments;
  if (meaningful.length === 0) {
    return { type: 'HOMEPAGE', confidence: 0.95, ambiguous: false, signals: ['locale root'] };
  }

  const scores = new Map<ClassifiedType, { score: number; signals: string[] }>();
  const bump = (type: ClassifiedType, score: number, signal: string) => {
    const entry = scores.get(type) ?? { score: 0, signals: [] };
    entry.score = Math.min(1, Math.max(entry.score, score) + (entry.score > 0 ? 0.05 : 0));
    entry.signals.push(signal);
    scores.set(type, entry);
  };

  const last = meaningful[meaningful.length - 1]!;
  for (const type of ORDER) {
    if (meaningful.length <= 2 && PATH_KEYWORDS[type].includes(last)) {
      bump(type, meaningful.length === 1 ? 0.9 : 0.8, `path segment "${last}"`);
    }
  }
  const anchor = (anchorText ?? '').replace(/\s+/g, ' ').trim();
  if (anchor && anchor.length <= 40) {
    for (const type of ORDER) {
      if (ANCHOR_PATTERNS[type].test(anchor)) bump(type, 0.75, `link text "${anchor}"`);
    }
  }
  const heading = (title ?? '').toLowerCase();
  if (heading && scores.size === 0) {
    for (const type of ORDER) {
      if (
        PATH_KEYWORDS[type].some((k) =>
          new RegExp(`\\b${k.replace(/-/g, '[ -]')}\\b`).test(heading),
        )
      ) {
        bump(type, 0.5, `title "${title}"`);
      }
    }
  }

  const ranked = [...scores.entries()].sort(
    (a, b) => b[1].score - a[1].score || ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]),
  );
  if (ranked.length === 0) {
    return { type: 'OTHER', confidence: 0.3, ambiguous: false, signals: [] };
  }
  const [top, runnerUp] = ranked;
  const conflict = runnerUp !== undefined && top![1].score - runnerUp[1].score < 0.15;
  return {
    type: top![0],
    confidence: Number(top![1].score.toFixed(2)),
    ambiguous: conflict || top![1].score < 0.7,
    signals: top![1].signals,
  };
}

/** Soft-404s and error pages that answer 200: never accept them as a careers/contact page. */
export function looksLikeErrorPage(title: string, text: string): boolean {
  return (
    /\b(404|page (not|cannot be) found|not found|no longer available|nothing here)\b/i.test(
      title,
    ) ||
    (text.length < 400 && /\b(404|page not found|doesn(?:'|’)t exist)\b/i.test(text))
  );
}

/** Off-site hosts that legitimately host a company's own job board. Linked, never crawled. */
const ATS_HOSTS = [
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'jobs.lever.co',
  'jobs.ashbyhq.com',
  'apply.workable.com',
  'bamboohr.com',
  'recruitee.com',
  'smartrecruiters.com',
  'teamtailor.com',
  'breezy.hr',
  'jobs.jobvite.com',
  'myworkdayjobs.com',
  'workable.com',
];

export function isKnownJobBoard(host: string): boolean {
  const h = host.toLowerCase();
  return ATS_HOSTS.some((ats) => h === ats || h.endsWith(`.${ats}`));
}

export function registrableDomain(hostOrUrl: string): string | undefined {
  const host = hostOrUrl.includes('/') ? new URL(hostOrUrl).hostname : hostOrUrl;
  return parse(host, { allowPrivateDomains: true }).domain ?? undefined;
}

/** Strip fragments and tracking params so the same page is stored once. */
export function canonicalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_|ref$)/i.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1 && url.pathname.endsWith('/'))
    url.pathname = url.pathname.slice(0, -1);
  return url.href;
}
