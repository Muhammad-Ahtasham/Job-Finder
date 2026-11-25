import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { foldText } from '@jobfinder/discovery';
import type { EmploymentType, WorkplaceType } from './types';

const MAX_DESCRIPTION = 20_000;

/** HTML → plain text. Never evaluates anything; scripts/styles are dropped. */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const $ = cheerio.load(html);
  $('script, style, noscript, template, iframe, object, embed').remove();
  $('br').replaceWith('\n');
  $('p, div, li, h1, h2, h3, h4, h5, h6, tr, ul, ol').each((_, el) => {
    $(el).append('\n');
  });
  const text = $.root()
    .text()
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text ? text.slice(0, MAX_DESCRIPTION) : null;
}

/** Greenhouse double-escapes: `content` is HTML whose markup is entity-encoded. */
export function decodeEntitiesOnce(value: string): string {
  return cheerio.load(`<i>${value}</i>`).root().text();
}

export function plainText(value: string | null | undefined): string | null {
  const text = (value ?? '').replace(/\r\n/g, '\n').trim();
  return text ? text.slice(0, MAX_DESCRIPTION) : null;
}

export function mapEmploymentType(raw: string | null | undefined): EmploymentType {
  const v = (raw ?? '').toLowerCase().replace(/[_-]/g, ' ');
  if (!v.trim()) return 'UNKNOWN';
  if (/\b(intern|internship|trainee|apprentice)/.test(v)) return 'INTERNSHIP';
  if (/\bpart ?time\b/.test(v)) return 'PART_TIME';
  if (/\b(contract|contractor|freelance|consultant|fixed term)\b/.test(v)) return 'CONTRACT';
  if (/\b(temp|temporary|seasonal)\b/.test(v)) return 'TEMPORARY';
  if (/\b(full ?time|permanent|regular)\b/.test(v)) return 'FULL_TIME';
  return 'OTHER';
}

export function mapWorkplaceType(raw: string | null | undefined): WorkplaceType {
  const v = (raw ?? '').toLowerCase().replace(/[_-]/g, ' ');
  if (!v.trim() || v === 'unspecified') return 'UNKNOWN';
  if (/\bhybrid\b/.test(v)) return 'HYBRID';
  if (/\b(remote|telecommute|work from home|wfh)\b/.test(v)) return 'REMOTE';
  if (/\b(on ?site|in ?office|office)\b/.test(v)) return 'ONSITE';
  return 'UNKNOWN';
}

/** Used only when a source states no workplace type: a location that IS "Remote". */
export function inferWorkplaceFromLocation(location: string | null): WorkplaceType {
  return location && /^\s*(remote|work from home)\b/i.test(location) ? 'REMOTE' : 'UNKNOWN';
}

export function parseDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

const clip = (value: string, max: number) => value.replace(/\s+/g, ' ').trim().slice(0, max);
export const cleanTitle = (value: unknown): string | null => {
  const title = typeof value === 'string' ? clip(value, 300) : '';
  return title || null;
};
export const cleanLocation = (value: unknown): string | null => {
  const location = typeof value === 'string' ? clip(value, 300) : '';
  return location || null;
};

/**
 * Cross-source identity of a vacancy: the same title in the same place is the same job whether
 * the company site or its ATS lists it. Not unique by itself (a company can open two identical
 * roles) — it is used to avoid re-importing a job a better source already provides.
 */
export function jobFingerprint(title: string, location: string | null): string {
  const key = `${foldText(title)}|${foldText((location ?? '').split(/[;|,]/)[0] ?? '')}`;
  return createHash('sha1').update(key).digest('hex');
}

export const sha1 = (value: string): string => createHash('sha1').update(value).digest('hex');

/** Board identifiers go into API URLs: refuse anything that is not a plain token. */
export const isSafeBoardKey = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
