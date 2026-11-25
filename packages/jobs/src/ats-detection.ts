import type { JobProviderRegistry } from './registry';
import type { BoardRef } from './types';

export interface AtsDetection {
  /** greenhouse | lever | ashby (supported) or the name of an ATS we recognise but cannot read. */
  platform: string;
  supported: boolean;
  /** Present only for supported platforms. */
  board?: BoardRef;
  /** The URL the detection is based on. */
  url: string;
  evidence: 'URL' | 'LINK' | 'EMBED';
}

/** ATS platforms we can identify by host but have no adapter for. Recognised, recorded, never scraped. */
const UNSUPPORTED_HOSTS: [string, string][] = [
  ['apply.workable.com', 'workable'],
  ['workable.com', 'workable'],
  ['smartrecruiters.com', 'smartrecruiters'],
  ['bamboohr.com', 'bamboohr'],
  ['recruitee.com', 'recruitee'],
  ['teamtailor.com', 'teamtailor'],
  ['breezy.hr', 'breezy'],
  ['jobvite.com', 'jobvite'],
  ['myworkdayjobs.com', 'workday'],
  ['personio.de', 'personio'],
  ['personio.com', 'personio'],
  ['icims.com', 'icims'],
  ['taleo.net', 'taleo'],
  ['successfactors.com', 'successfactors'],
  ['pinpointhq.com', 'pinpoint'],
  ['join.com', 'join'],
  ['rippling.com', 'rippling'],
];

const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\)]{4,300}/gi;
const MAX_URLS = 800;

/**
 * Identifies which applicant-tracking system hosts a career page: from its URL, from links
 * on a page, and from embeds (iframes / scripts / inline snippets) in its HTML. Supported
 * platforms are resolved to a board by the registered providers' own `identify`, so the
 * patterns live next to the API each adapter actually calls.
 */
export class ATSDetectionService {
  constructor(private readonly registry: JobProviderRegistry) {}

  detectFromUrl(url: string, evidence: AtsDetection['evidence'] = 'URL'): AtsDetection | null {
    const match = this.registry.identify(url);
    if (match) {
      return {
        platform: match.provider.id,
        supported: true,
        board: match.board,
        url,
        evidence,
      };
    }
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
    const unsupported = UNSUPPORTED_HOSTS.find(([h]) => host === h || host.endsWith(`.${h}`));
    return unsupported ? { platform: unsupported[1], supported: false, url, evidence } : null;
  }

  /**
   * Scan raw HTML for ATS references. Looks at every absolute URL anywhere in the markup
   * (href, iframe/script src, data attributes, inline JSON/JS), so an embedded
   * `boards.greenhouse.io/embed/job_board/js?for=acme` is found without running the page.
   */
  detectFromHtml(html: string, linkUrls: string[] = []): AtsDetection[] {
    const found = new Map<string, AtsDetection>();
    const consider = (url: string, evidence: AtsDetection['evidence']) => {
      const detection = this.detectFromUrl(url, evidence);
      if (!detection) return;
      const key = detection.board
        ? `${detection.board.providerId}:${detection.board.region ?? ''}:${detection.board.boardKey.toLowerCase()}`
        : `${detection.platform}:${safeHost(url)}`;
      // Prefer the strongest evidence (a link beats an embed beats nothing) for the same board.
      if (!found.has(key)) found.set(key, detection);
    };
    for (const url of linkUrls) consider(url, 'LINK');
    let count = 0;
    for (const match of html.matchAll(URL_IN_TEXT)) {
      if (++count > MAX_URLS) break;
      consider(
        match[0]
          .replace(/&amp;/g, '&')
          .replace(/\\u0026/g, '&')
          .replace(/[.,;]+$/, ''),
        'EMBED',
      );
    }
    return [...found.values()];
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
