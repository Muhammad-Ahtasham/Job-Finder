const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });
const dateTimeFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

export const formatDate = (iso: string | null | undefined) =>
  iso ? dateFormat.format(new Date(iso)) : '—';
export const formatDateTime = (iso: string | null | undefined) =>
  iso ? dateTimeFormat.format(new Date(iso)) : '—';

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) {
    const n = Math.floor(seconds / 60);
    return `${n} minute${n === 1 ? '' : 's'} ago`;
  }
  if (seconds < 86_400) {
    const n = Math.floor(seconds / 3600);
    return `${n} hour${n === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(seconds / 86_400);
  return days < 30 ? `${days} day${days === 1 ? '' : 's'} ago` : formatDate(iso);
}

/** "SOFTWARE_ENGINEERING" → "Software engineering". */
export const humanize = (value: string) => {
  const text = value.toLowerCase().replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export function formatExperience(min: number | null, max: number | null): string {
  if (min === null && max === null) return '—';
  if (min !== null && max !== null && max !== min) return `${min}–${max} yrs`;
  return `${min ?? max}+ yrs`;
}

/** Only http(s) URLs are ever rendered as links. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

export const displayUrl = (url: string) =>
  url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
