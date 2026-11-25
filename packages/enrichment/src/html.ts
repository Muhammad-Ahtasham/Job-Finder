import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

export interface ParsedLink {
  /** Absolute URL, fragment removed. */
  url: string;
  text: string;
}

export interface JsonLdOrganization {
  names: string[];
  urls: string[];
  emails: string[];
  sameAs: string[];
  addresses: string[];
}

export interface ParsedPage {
  title: string;
  metaDescription: string;
  siteName: string;
  h1: string[];
  /** Visible text only: scripts, styles and hidden elements are removed. Capped. */
  text: string;
  links: ParsedLink[];
  /** Raw mailto: targets with the anchor text they were found in. */
  mailtos: { value: string; text: string }[];
  /** Hex payloads of Cloudflare e-mail protection, decoded by the e-mail extractor. */
  cfEmails: string[];
  jsonLd: JsonLdOrganization;
  noindex: boolean;
}

const MAX_TEXT = 40_000;
const MAX_LINKS = 600;
const HIDDEN_STYLE =
  /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px)?\s*(?:;|$)/i;

const clean = (value: string | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();

/**
 * Deterministic HTML → structured data. cheerio parses markup into a tree and nothing more:
 * no script runs, no resource is fetched. Hidden elements are dropped so honeypot/spam-trap
 * addresses are not harvested.
 */
export function parsePage(html: string, pageUrl: string): ParsedPage {
  const $ = cheerio.load(html);

  const jsonLd = readJsonLd($);
  const cfEmails: string[] = [];
  $('[data-cfemail]').each((_, el) => {
    const value = $(el).attr('data-cfemail');
    if (value) cfEmails.push(value);
  });
  $('a[href*="/cdn-cgi/l/email-protection#"]').each((_, el) => {
    const hash = $(el).attr('href')?.split('#')[1];
    if (hash) cfEmails.push(hash);
  });

  $('script, style, noscript, template, svg, iframe, object, embed, [hidden]').remove();
  $('[aria-hidden="true"]').each((_, el) => {
    // aria-hidden marks decorative icons; only treat it as hiding when it hides real text.
    if ($(el).is('a, p, span, div, li') && clean($(el).text()).includes('@')) $(el).remove();
  });
  $('[style]').each((_, el) => {
    if (HIDDEN_STYLE.test($(el).attr('style') ?? '')) $(el).remove();
  });

  const baseHref = $('base[href]').first().attr('href');
  let base: URL;
  try {
    base = new URL(baseHref ?? pageUrl, pageUrl);
  } catch {
    base = new URL(pageUrl);
  }

  const links: ParsedLink[] = [];
  const mailtos: { value: string; text: string }[] = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href) return;
    const text = clean($(el).text() || $(el).attr('title') || $(el).attr('aria-label'));
    if (/^mailto:/i.test(href)) {
      mailtos.push({ value: href.slice(7), text });
      return;
    }
    if (/^(javascript|tel|sms|data|blob|file|ftp):/i.test(href) || href.startsWith('#')) return;
    if (links.length >= MAX_LINKS) return;
    try {
      const url = new URL(href, base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      url.hash = '';
      links.push({ url: url.href, text: text.slice(0, 200) });
    } catch {
      /* malformed href: ignore */
    }
  });

  const meta = (selector: string) => clean($(selector).first().attr('content'));
  return {
    title: clean($('title').first().text()).slice(0, 300),
    metaDescription: meta('meta[name="description"]').slice(0, 500),
    siteName: meta('meta[property="og:site_name"]').slice(0, 200),
    h1: $('h1')
      .map((_, el) => clean($(el).text()).slice(0, 200))
      .get()
      .filter(Boolean)
      .slice(0, 5),
    text: clean($('body').text() || $.root().text()).slice(0, MAX_TEXT),
    links,
    mailtos,
    cfEmails,
    jsonLd,
    noindex: /noindex/i.test(meta('meta[name="robots"]')),
  };
}

/** Collect Organization-ish facts from JSON-LD. It is parsed as data and never evaluated. */
function readJsonLd($: cheerio.CheerioAPI): JsonLdOrganization {
  const result: JsonLdOrganization = { names: [], urls: [], emails: [], sameAs: [], addresses: [] };
  const strings = (value: unknown): string[] =>
    (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string');

  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 50)) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const type = strings(record['@type']).join(' ');
    if (
      /Organization|Corporation|LocalBusiness|Company|WebSite|Employer|ProfessionalService/i.test(
        type,
      )
    ) {
      result.names.push(...strings(record.name), ...strings(record.legalName));
      result.urls.push(...strings(record.url));
      result.emails.push(...strings(record.email));
      result.sameAs.push(...strings(record.sameAs));
      const address = record.address;
      if (typeof address === 'string') result.addresses.push(address);
      else if (address && typeof address === 'object') {
        const a = address as Record<string, unknown>;
        result.addresses.push(
          [a.streetAddress, a.addressLocality, a.addressRegion, a.addressCountry]
            .filter((v): v is string => typeof v === 'string')
            .join(', '),
        );
      }
    }
    for (const value of Object.values(record)) visit(value, depth + 1);
  };

  $('script[type="application/ld+json"]')
    .slice(0, 10)
    .each((_, el) => {
      const raw = $(el).contents().text();
      if (raw.length > 200_000) return;
      try {
        visit(JSON.parse(raw), 0);
      } catch {
        /* invalid JSON-LD: ignore */
      }
    });
  for (const key of Object.keys(result) as (keyof JsonLdOrganization)[]) {
    result[key] = [...new Set(result[key].map(clean).filter(Boolean))].slice(0, 20);
  }
  return result;
}

export const contentHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');
