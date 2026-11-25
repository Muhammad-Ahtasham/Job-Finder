import { parse } from 'tldts';
import type { ParsedPage } from './html';
import type { EmailCategory, ExtractionMethod, PageType } from './types';

/**
 * E-mail extraction takes ONLY addresses that a page literally publishes (mailto: links,
 * visible text, JSON-LD, Cloudflare-protected markup, or "name [at] host [dot] com"
 * obfuscation). Addresses are never constructed from naming conventions, and DNS records
 * are never taken as evidence that a mailbox exists.
 */
export interface EmailCandidate {
  email: string;
  method: ExtractionMethod;
  /** Text around the match (or the anchor text), for classification and review. */
  context: string;
}

const EMAIL_PATTERN =
  /[a-z0-9][a-z0-9._%+-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}/gi;

/** Documentation / template / tracking domains whose addresses are never a company's own. */
const PLACEHOLDER_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'domain.com',
  'yourdomain.com',
  'yourcompany.com',
  'company.com',
  'email.com',
  'mail.com',
  'test.com',
  'sentry.io',
  'wixpress.com',
  'sentry-next.wixpress.com',
]);
const PLACEHOLDER_LOCALS = new Set([
  'name',
  'yourname',
  'your.name',
  'user',
  'username',
  'email',
  'your-email',
  'youremail',
  'someone',
  'you',
  'johndoe',
  'john.doe',
  'first.last',
  'firstname.lastname',
]);
const ASSET_SUFFIX = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|woff2?|ttf|eot|map|mp4|pdf)$/i;

export function normalizeEmail(raw: string): string | undefined {
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep raw */
  }
  value = value
    .replace(/^mailto:/i, '')
    .replace(/[?#].*$/, '')
    .replace(/[\s<>"'(),;:.!]+$/g, '')
    .replace(/^[\s<>"'(),;:]+/g, '')
    .toLowerCase();
  if (value.length > 254 || ASSET_SUFFIX.test(value)) return undefined;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return undefined;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return undefined;
  }
  if (PLACEHOLDER_DOMAINS.has(domain) || PLACEHOLDER_LOCALS.has(local)) return undefined;
  const parsed = parse(domain, { allowPrivateDomains: false });
  if (!parsed.domain || !parsed.isIcann) return undefined;
  if (/^[0-9a-f]{24,}$/.test(local)) return undefined; // tracking ids (e.g. sentry keys)
  return value;
}

/** Decode Cloudflare's `data-cfemail` hex: first byte is an XOR key for the rest. */
export function decodeCloudflareEmail(hex: string): string | undefined {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2 !== 0) return undefined;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return out;
}

const snippet = (text: string, index: number, length: number) =>
  text.slice(Math.max(0, index - 80), Math.min(text.length, index + length + 80)).trim();

/** Bracketed obfuscation only: "[at]" / "(at)" / "{dot}". Bare " at " is far too ambiguous. */
function deobfuscate(text: string): string {
  return text
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, '@')
    .replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, '.');
}

/** Every address the page literally publishes, de-duplicated (strongest method wins). */
export function extractEmailCandidates(page: ParsedPage): EmailCandidate[] {
  const found = new Map<string, EmailCandidate>();
  const rank: Record<ExtractionMethod, number> = {
    MAILTO: 6,
    JSON_LD: 5,
    CLOUDFLARE_PROTECTED: 4,
    TEXT: 3,
    OBFUSCATED: 2,
    AI_ASSISTED: 1,
    LINK: 0,
  };
  const add = (raw: string, method: ExtractionMethod, context: string) => {
    const email = normalizeEmail(raw);
    if (!email) return;
    const existing = found.get(email);
    if (!existing || rank[method] > rank[existing.method]) {
      found.set(email, { email, method, context: context.slice(0, 240) });
    }
  };

  for (const mailto of page.mailtos) {
    for (const part of mailto.value.split('?')[0]!.split(/[,;]/)) {
      add(part, 'MAILTO', mailto.text);
    }
  }
  for (const value of page.jsonLd.emails) add(value, 'JSON_LD', 'JSON-LD Organization');
  for (const hex of page.cfEmails) {
    const decoded = decodeCloudflareEmail(hex);
    if (decoded) add(decoded, 'CLOUDFLARE_PROTECTED', 'Cloudflare-protected address');
  }
  for (const match of page.text.matchAll(EMAIL_PATTERN)) {
    add(match[0], 'TEXT', snippet(page.text, match.index ?? 0, match[0].length));
  }
  const plain = new Set(found.keys());
  const decoded = deobfuscate(page.text);
  if (decoded !== page.text) {
    for (const match of decoded.matchAll(EMAIL_PATTERN)) {
      const email = normalizeEmail(match[0]);
      if (email && !plain.has(email)) {
        add(match[0], 'OBFUSCATED', snippet(decoded, match.index ?? 0, match[0].length));
      }
    }
  }
  return [...found.values()];
}

// ---------------------------------------------------------------- classification

export interface EmailClassification {
  category: EmailCategory;
  /** 0..1. Below AMBIGUOUS_BELOW the caller may ask the (optional) AI assistant. */
  confidence: number;
  reason: string;
}

export const AMBIGUOUS_BELOW = 0.7;

const EXACT: Record<Exclude<EmailCategory, 'OTHER'>, string[]> = {
  RECRUITMENT: [
    'recruit',
    'recruiter',
    'recruiters',
    'recruitment',
    'recruiting',
    'talent',
    'talentacquisition',
    'hiring',
    'staffing',
    'apply',
    'applications',
    'application',
    'cv',
    'cvs',
    'resume',
    'resumes',
  ],
  CAREERS: [
    'career',
    'careers',
    'job',
    'jobs',
    'vacancy',
    'vacancies',
    'opening',
    'openings',
    'opportunities',
    'joinus',
    'jointheteam',
    'workwithus',
    'work',
  ],
  HR: [
    'hr',
    'humanresources',
    'humanresource',
    'hrteam',
    'hrdept',
    'hrdepartment',
    'hrd',
    'people',
    'peopleops',
    'peopleandculture',
    'peopleteam',
    'personnel',
  ],
  GENERAL: [
    'info',
    'contact',
    'contactus',
    'hello',
    'hi',
    'hey',
    'office',
    'admin',
    'mail',
    'enquiry',
    'enquiries',
    'inquiry',
    'inquiries',
    'support',
    'help',
    'sales',
    'team',
    'general',
    'service',
    'services',
    'customercare',
    'care',
    'reception',
    'marketing',
    'business',
    'bd',
    'press',
    'media',
    'accounts',
    'billing',
    'feedback',
  ],
};
const PRIORITY: Exclude<EmailCategory, 'OTHER'>[] = ['RECRUITMENT', 'CAREERS', 'HR', 'GENERAL'];

/**
 * Deterministic classification from the local part (and where the address was published).
 * An exact role word is confident; a role word merely contained in the name is not.
 */
export function classifyEmailDeterministic(
  email: string,
  context: { pageType?: PageType; text?: string } = {},
): EmailClassification {
  const local = email.split('@')[0]!;
  const joined = local.replace(/[._+-]/g, '');
  const tokens = local.split(/[._+-]+/).filter(Boolean);

  for (const category of PRIORITY) {
    const words = EXACT[category];
    if (words.includes(joined) || (tokens.length > 0 && tokens.every((t) => words.includes(t)))) {
      return {
        category,
        confidence: 0.92,
        reason: `Local part "${local}" is a ${category} role address`,
      };
    }
  }
  for (const category of PRIORITY) {
    if (tokens.some((t) => EXACT[category].includes(t))) {
      return {
        category,
        confidence: 0.78,
        reason: `Local part "${local}" contains a ${category} role word`,
      };
    }
  }
  // "recruitment-pk", "hrdept2": a role word embedded in a longer token. Weak.
  for (const category of PRIORITY.filter((c) => c !== 'GENERAL')) {
    const hit = EXACT[category].find((w) => w.length >= 4 && joined.includes(w));
    if (hit) {
      return { category, confidence: 0.55, reason: `Local part "${local}" embeds "${hit}"` };
    }
  }
  if (
    context.text &&
    (context.pageType === 'CAREERS' || context.pageType === 'JOBS') &&
    /\b(send|submit|email|mail|forward)\b.{0,60}\b(cv|resume|r[ée]sum[ée]|application)\b/i.test(
      context.text,
    )
  ) {
    return {
      category: 'RECRUITMENT',
      confidence: 0.65,
      reason: 'Published as the address for sending CVs',
    };
  }
  return { category: 'OTHER', confidence: 0.5, reason: `No role word in "${local}"` };
}

/**
 * Confidence that the address is a genuine, intentionally published contact of THIS company
 * (as opposed to a plugin author, a partner or a template). Not a deliverability estimate.
 */
export function emailPublicationConfidence(input: {
  method: ExtractionMethod;
  domainMatch: boolean;
  pageType: PageType;
}): number {
  const base: Record<ExtractionMethod, number> = {
    MAILTO: 0.95,
    JSON_LD: 0.92,
    CLOUDFLARE_PROTECTED: 0.9,
    TEXT: 0.85,
    OBFUSCATED: 0.7,
    AI_ASSISTED: 0.5,
    LINK: 0.9,
  };
  let confidence = base[input.method];
  if (!input.domainMatch) confidence -= 0.25;
  if (input.pageType !== 'CONTACT' && input.pageType !== 'CAREERS' && input.pageType !== 'JOBS') {
    confidence -= 0.05;
  }
  return Math.max(0.05, Math.min(1, Number(confidence.toFixed(2))));
}

/** True when the e-mail's domain is the company's registrable domain (or a subdomain of it). */
export function emailDomainMatches(email: string, siteDomain: string): boolean {
  const domain = parse(email.split('@')[1]!).domain;
  return domain === siteDomain.toLowerCase();
}
