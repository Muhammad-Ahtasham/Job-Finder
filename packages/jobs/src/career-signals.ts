import type { ParsedPage } from '@jobfinder/enrichment';

/** Words in a link/URL that point to recruitment. */
export const CAREER_URL_WORDS =
  /(^|[/_-])(careers?|jobs?|join-?us|join-?(our|the)-?team|work-?(with|for)-?us|vacanc(?:y|ies)|openings?|hiring|opportunit(?:y|ies)|recruit(?:ment|ing)?|life-?at-?[a-z0-9-]+|we-?are-?hiring|were-?hiring)([/_.-]|$)/i;
const NOT_RECRUITMENT_PATH =
  /\/(blog|news|press|articles?|insights?|stories|events?|webinars?|resources|case-?stud(?:y|ies)|podcast)\b/i;

export const CAREER_ANCHOR =
  /^(careers?|jobs?|join (us|our team|the team)|work (with|for) us|we(?:'|’)?re hiring|we are hiring|open (positions|roles|jobs)|(current |job )?(openings|vacancies)|opportunities|life at .{2,40}|explore (careers|roles|opportunities)|view (open )?(jobs|roles|positions))$/i;

const PHRASES: RegExp[] = [
  /\b(open|current|available) (positions|roles|vacancies|openings|jobs)\b/i,
  /\b(job|career) (openings|opportunities|listings)\b/i,
  /\b(we(?:'|’)?re|we are) (hiring|looking for)\b/i,
  /\bapply (now|today|here|for this)\b/i,
  /\b(send|submit|email) (us )?your (cv|resume|application)\b/i,
  /\bjoin (our|the) team\b/i,
  /\b(equal opportunity employer|benefits|what we offer)\b/i,
];

export interface RecruitmentScore {
  /** 0..1: how strongly the page content looks like a recruitment page. */
  score: number;
  signals: string[];
}

/**
 * Judge a page by what it says, not by where it lives: structured JobPosting data, ATS
 * embeds, recruitment phrasing, a heading about careers, and a list of posting-like links.
 */
export function scoreRecruitmentContent(html: string, page: ParsedPage): RecruitmentScore {
  const signals: string[] = [];
  let score = 0;
  const add = (points: number, signal: string) => {
    score += points;
    signals.push(signal);
  };

  if (/"@type"\s*:\s*\[?\s*"JobPosting"|itemtype=["'][^"']*schema\.org\/JobPosting/i.test(html)) {
    add(0.6, 'schema.org JobPosting data');
  }
  const heading = `${page.title} ${page.h1.join(' ')}`;
  if (
    /\b(careers?|jobs|join (us|our team|the team)|work (with|for) us|vacancies|openings|hiring|opportunities)\b/i.test(
      heading,
    )
  ) {
    add(0.25, 'career wording in title/heading');
  }
  const phrases = PHRASES.filter((p) => p.test(page.text.slice(0, 20_000))).length;
  if (phrases > 0) add(Math.min(0.4, phrases * 0.15), `${phrases} recruitment phrase(s)`);

  const postingLinks = page.links.filter(
    (l) =>
      /\/(jobs?|careers?|positions?|openings?|vacanc(?:y|ies)|roles?)\/[^/?#]{3,}|[?&](gh_jid|jobid|job_id)=/i.test(
        l.url,
      ) && l.text.length >= 4,
  ).length;
  if (postingLinks >= 3) add(0.3, `${postingLinks} links that look like individual postings`);
  return { score: Math.min(1, Number(score.toFixed(2))), signals };
}

/** Link-level score from the URL and anchor text alone (before the page is fetched). */
export function scoreCareerLink(
  url: string,
  anchorText: string,
): { score: number; signals: string[] } {
  const signals: string[] = [];
  let score = 0;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return { score: 0, signals };
  }
  const anchor = anchorText.replace(/\s+/g, ' ').trim();
  if (CAREER_URL_WORDS.test(path)) {
    score += 0.4;
    signals.push('career wording in URL');
  }
  if (anchor && anchor.length <= 50 && CAREER_ANCHOR.test(anchor)) {
    score += 0.45;
    signals.push(`link text "${anchor}"`);
  }
  if (NOT_RECRUITMENT_PATH.test(path)) {
    score -= 0.5;
    signals.push('looks like blog/news content');
  }
  return { score: Math.max(0, Number(score.toFixed(2))), signals };
}
