import * as cheerio from 'cheerio';
import {
  cleanLocation,
  cleanTitle,
  htmlToText,
  inferWorkplaceFromLocation,
  mapEmploymentType,
  mapWorkplaceType,
  parseDate,
  sha1,
} from './normalize';
import type { BoardRef, ExtractionKind, NormalizedJob } from './types';

export interface GenericExtraction {
  jobs: NormalizedJob[];
  /** The page says, in words, that there are no vacancies. */
  statesNoOpenings: boolean;
  /** Link to the next page of listings, if the page paginates. */
  nextPageUrl?: string;
  /** Visible text and links, kept so an AI fallback can be offered the same input. */
  text: string;
  links: { text: string; url: string }[];
}

const NO_OPENINGS =
  /\b(no (?:current |open |available )?(?:openings|vacancies|positions|jobs|roles)(?: available| at (?:the|this) (?:moment|time))?|(?:currently|presently) (?:have )?no (?:open )?(?:openings|vacancies|positions)|not (?:currently )?hiring|there are no (?:open|current) (?:positions|roles|openings|vacancies)|check back (?:later|soon))\b/i;

const NOT_A_TITLE =
  /^(apply( now| here| today)?|learn more|read more|view( all| more| details| job| role)?|see (all|more)( jobs| openings)?|show more|details|more info|home|next|previous|prev|back|submit|share|contact( us)?|about( us)?|careers?|jobs|login|sign ?(in|up)|search|filter|all (jobs|departments|locations)|open positions|join (us|our team)|privacy( policy)?|terms.*)$/i;

/** Path shapes of an individual posting (not of the listing page itself). */
const JOB_PATH =
  /\/(jobs?|careers?|positions?|openings?|vacanc(?:y|ies)|opportunit(?:y|ies)|roles?|postings?|requisitions?|apply)\/[^/?#]{3,}|[?&](gh_jid|jobid|job_id|jid|positionid|requisitionid|vacancyid|lever-source)=/i;

const text = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

/**
 * Extract published jobs from an arbitrary career page without any AI, in decreasing order
 * of trust: schema.org JobPosting (JSON-LD, then microdata), then repeated job-link
 * structures in the page body. Nothing is invented: a field the page does not state is null.
 */
export function extractJobsFromHtml(
  html: string,
  pageUrl: string,
  board: BoardRef,
): GenericExtraction {
  const $ = cheerio.load(html);
  const base = (() => {
    try {
      return new URL($('base[href]').first().attr('href') ?? pageUrl, pageUrl);
    } catch {
      return new URL(pageUrl);
    }
  })();

  const jobs: NormalizedJob[] = [];
  const seen = new Set<string>();
  const push = (
    job: Omit<NormalizedJob, 'providerId' | 'boardKey' | 'externalId' | 'extraction'> & {
      key: string;
    },
    extraction: ExtractionKind,
  ) => {
    const externalId = sha1(job.key);
    if (seen.has(externalId)) return;
    seen.add(externalId);
    const { key: _key, ...rest } = job;
    jobs.push({
      providerId: board.providerId,
      boardKey: board.boardKey,
      externalId,
      extraction,
      ...rest,
    });
  };
  const abs = (href: string | undefined | null): string | null => {
    if (!href) return null;
    try {
      const url = new URL(href, base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  };

  // ---- 1. JSON-LD JobPosting
  $('script[type="application/ld+json"]')
    .slice(0, 20)
    .each((_, el) => {
      const raw = $(el).contents().text();
      if (raw.length > 2_000_000) return;
      try {
        visitJsonLd(JSON.parse(raw), 0, (posting) => {
          const title = cleanTitle(posting.title ?? posting.name);
          if (!title) return;
          const url =
            abs(str(posting.url)) ?? abs(str(asObj(posting.mainEntityOfPage)?.['@id'])) ?? pageUrl;
          const locations = jsonLdLocations(posting.jobLocation);
          const remote = /telecommute/i.test(str(posting.jobLocationType) ?? '');
          const location = locations[0] ?? null;
          const employment =
            [posting.employmentType]
              .flat()
              .map((v) => mapEmploymentType(str(v)))
              .find((t) => t !== 'UNKNOWN') ?? 'UNKNOWN';
          const identifier = asObj(posting.identifier);
          push(
            {
              key: str(identifier?.value) ?? str(posting.identifier) ?? url,
              title,
              description: htmlToText(str(posting.description)),
              location,
              locations,
              department: str(posting.occupationalCategory) ?? null,
              employmentType: employment,
              workplaceType: remote ? 'REMOTE' : inferWorkplaceFromLocation(location),
              applicationUrl:
                abs(str(posting.directApply === true ? posting.url : undefined)) ?? url,
              sourceUrl: url,
              publishedAt: parseDate(posting.datePosted),
            },
            'JSON_LD',
          );
        });
      } catch {
        /* invalid JSON-LD: ignore */
      }
    });

  // ---- 2. Microdata JobPosting
  $('[itemtype*="schema.org/JobPosting"]').each((_, el) => {
    const prop = (name: string) =>
      text(
        $(el).find(`[itemprop="${name}"]`).first().attr('content') ??
          $(el).find(`[itemprop="${name}"]`).first().text(),
      );
    const title = cleanTitle(prop('title') || prop('name'));
    if (!title) return;
    const url = abs($(el).find('[itemprop="url"]').first().attr('href')) ?? pageUrl;
    const location = cleanLocation(prop('jobLocation'));
    push(
      {
        key: url === pageUrl ? `${pageUrl}#${title}` : url,
        title,
        description: htmlToText(prop('description')),
        location,
        locations: location ? [location] : [],
        department: null,
        employmentType: mapEmploymentType(prop('employmentType')),
        workplaceType: inferWorkplaceFromLocation(location),
        applicationUrl: url,
        sourceUrl: url,
        publishedAt: parseDate(prop('datePosted')),
      },
      'MICRODATA',
    );
  });

  // ---- visible text + links (also the AI fallback's input)
  const cleaned = cheerio.load(html);
  cleaned('script, style, noscript, template, svg, iframe, [hidden]').remove();
  const links: { text: string; url: string }[] = [];
  cleaned('a[href]').each((_, el) => {
    const url = abs(cleaned(el).attr('href'));
    if (url && links.length < 800)
      links.push({ text: text(cleaned(el).text()).slice(0, 200), url });
  });
  const pageText = text(cleaned('body').text() || cleaned.root().text()).slice(0, 40_000);

  // ---- 3. Repeated job links in the body
  if (jobs.length === 0) {
    for (const found of linkedJobs(cleaned, abs, pageUrl)) {
      push(
        {
          key: found.url,
          title: found.title,
          description: null,
          location: found.location,
          locations: found.location ? [found.location] : [],
          department: null,
          employmentType: found.employment,
          workplaceType:
            found.workplace !== 'UNKNOWN'
              ? found.workplace
              : inferWorkplaceFromLocation(found.location),
          applicationUrl: found.url,
          sourceUrl: found.url,
          publishedAt: null,
        },
        'HTML',
      );
    }
  }

  const next = abs(
    cleaned('a[rel="next"], link[rel="next"]').first().attr('href') ??
      cleaned('a[aria-label*="next" i]').first().attr('href'),
  );
  return {
    jobs,
    statesNoOpenings: jobs.length === 0 && NO_OPENINGS.test(pageText),
    nextPageUrl: next && next !== pageUrl ? next : undefined,
    text: pageText,
    links,
  };
}

interface LinkedJob {
  url: string;
  title: string;
  location: string | null;
  employment: ReturnType<typeof mapEmploymentType>;
  workplace: ReturnType<typeof mapWorkplaceType>;
}

/**
 * Heuristic: anchors that look like postings (posting-shaped href, title-shaped text, not in
 * nav/header/footer) and that appear at least twice under the same container. A lone link is
 * far more likely to be navigation, so it is not enough.
 */
function linkedJobs(
  $: cheerio.CheerioAPI,
  abs: (href: string | undefined | null) => string | null,
  pageUrl: string,
): LinkedJob[] {
  const groups = new Map<unknown, LinkedJob[]>();
  $('a[href]').each((_, el) => {
    if (
      $(el).closest(
        'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]',
      ).length
    )
      return;
    const url = abs($(el).attr('href'));
    if (!url || url === pageUrl || !JOB_PATH.test(url)) return;
    const heading = text(
      $(el).find('h1, h2, h3, h4, h5, strong, [class*="title" i]').first().text(),
    );
    const title = cleanTitle(heading || text($(el).text()));
    const words = title?.split(' ').length ?? 0;
    if (!title || NOT_A_TITLE.test(title) || words > 14 || title.length < 4) return;

    // Metadata lives in the same list item / table row / card, next to the link.
    const item = $(el)
      .closest(
        'li, tr, article, [class*="job" i], [class*="position" i], [class*="opening" i], [class*="card" i]',
      )
      .first();
    const scope = item.length ? item : $(el).parent();
    const around = text(scope.text()).replace(title, ' ');
    const locationNode = text(
      scope.find('[class*="location" i], [itemprop*="location" i]').first().text(),
    );
    const job: LinkedJob = {
      url,
      title,
      location: cleanLocation(locationNode),
      employment: mapEmploymentType(
        /\b(full[- ]?time|part[- ]?time|contract|internship|intern|temporary|freelance)\b/i.exec(
          around,
        )?.[0],
      ),
      workplace: mapWorkplaceType(/\b(hybrid|remote|on[- ]?site)\b/i.exec(around)?.[0]),
    };
    const container = scope.parent().get(0) ?? scope.get(0);
    const list = groups.get(container) ?? [];
    list.push(job);
    groups.set(container, list);
  });

  // The largest cluster of posting-like links is the listing.
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  return best && best.length >= 2 ? best : [];
}

// ------------------------------------------------------------------ JSON-LD helpers

const asObj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

function visitJsonLd(
  node: unknown,
  depth: number,
  onPosting: (p: Record<string, unknown>) => void,
): void {
  if (depth > 6 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 500)) visitJsonLd(item, depth + 1, onPosting);
    return;
  }
  const record = node as Record<string, unknown>;
  if ([record['@type']].flat().some((t) => t === 'JobPosting')) onPosting(record);
  for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity']) {
    if (record[key]) visitJsonLd(record[key], depth + 1, onPosting);
  }
}

function jsonLdLocations(value: unknown): string[] {
  const places = [value]
    .flat()
    .map(asObj)
    .filter((p): p is Record<string, unknown> => !!p);
  return places
    .map((place) => {
      const address = asObj(place.address);
      return cleanLocation(
        [
          str(address?.addressLocality),
          str(address?.addressRegion),
          str(asObj(address?.addressCountry)?.name) ?? str(address?.addressCountry),
        ]
          .filter(Boolean)
          .join(', ') || str(place.name),
      );
    })
    .filter((l): l is string => !!l);
}
