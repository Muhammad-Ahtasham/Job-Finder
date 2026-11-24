import { parse } from 'tldts';

/**
 * Domains that are never "the company's own website": directories, social networks,
 * job boards, publishers and code hosts. A search hit on one of these is a *page about*
 * companies, not a company, and must never become a domain identity (that would merge
 * unrelated companies). Extend as new noise is observed.
 */
const AGGREGATOR_DOMAINS = new Set([
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'tiktok.com',
  'pinterest.com',
  'reddit.com',
  'quora.com',
  'medium.com',
  'wikipedia.org',
  'wikimedia.org',
  'github.com',
  'gitlab.com',
  'crunchbase.com',
  'clutch.co',
  'goodfirms.co',
  'glassdoor.com',
  'indeed.com',
  'rozee.pk',
  'mustakbil.com',
  'jobz.pk',
  'google.com',
  'bing.com',
  'yelp.com',
  'yellowpages.com',
  'yellowpages.com.pk',
  'zoominfo.com',
  'dnb.com',
  'owler.com',
  'tracxn.com',
  'f6s.com',
  'g2.com',
  'capterra.com',
  'trustpilot.com',
  'sortlist.com',
  'themanifest.com',
  'designrush.com',
  'topdevelopers.co',
  'upwork.com',
  'fiverr.com',
  'freelancer.com',
  'dawn.com',
  'tribune.com.pk',
  'thenews.com.pk',
  'brecorder.com',
  'propakistani.pk',
  'techjuice.pk',
  'amazon.com',
  'alibaba.com',
  'olx.com.pk',
  'openstreetmap.org',
]);

export function isAggregatorDomain(domain: string): boolean {
  return AGGREGATOR_DOMAINS.has(domain);
}

export interface NormalizedWebsite {
  /** Canonical homepage: `https://host/` (scheme preserved as given, path dropped). */
  url: string;
  host: string;
  /** Registrable domain (eTLD+1, private suffixes respected: foo.github.io stays distinct). */
  domain: string;
}

/**
 * Parse a user/provider supplied URL. Returns undefined for anything that is not a plain
 * http(s) site with a registrable domain (IPs, localhost, mailto:, garbage).
 */
export function normalizeWebsite(input: string | undefined): NormalizedWebsite | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048) return undefined;
  // Non-web schemes without "//" (mailto:, tel:, javascript:) must not be mistaken for hosts.
  if (/^(mailto|tel|sms|javascript|data|file|ftp|blob):/i.test(trimmed)) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;

  const parsed = parse(url.hostname, { allowPrivateDomains: true });
  if (!parsed.domain || parsed.isIp) return undefined;

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return { url: `${url.protocol}//${host}/`, host, domain: parsed.domain.toLowerCase() };
}
