import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERVALS,
  DEFAULT_MISS_POLICY,
  NO_MISSES,
  dedupeKey,
  defaultIntervalMinutes,
  kindForProvider,
  nextRunAfterAnswer,
  nextRunAfterFailure,
  nextRunForRecheck,
  registerMiss,
  renderNotification,
  scheduleHealth,
  scopeKey,
  wants,
  type NotificationEvent,
} from '../src';

const now = new Date('2026-11-29T10:00:00Z');
const minutes = (d: Date) => (d.getTime() - now.getTime()) / 60_000;

describe('schedules', () => {
  it('has the documented initial frequencies', () => {
    expect(DEFAULT_INTERVALS).toEqual({
      atsMinutes: 720,
      careerPageMinutes: 1440,
      websiteMinutes: 10_080,
    });
    expect(defaultIntervalMinutes('ATS_BOARD', DEFAULT_INTERVALS)).toBe(720);
    expect(defaultIntervalMinutes('CAREER_PAGE', DEFAULT_INTERVALS)).toBe(1440);
    expect(defaultIntervalMinutes('WEBSITE', DEFAULT_INTERVALS)).toBe(10_080);
  });
  it('classifies sources', () => {
    for (const p of ['greenhouse', 'lever', 'ashby']) expect(kindForProvider(p)).toBe('ATS_BOARD');
    expect(kindForProvider('generic-html')).toBe('CAREER_PAGE');
    expect(scopeKey('WEBSITE', 'abc')).toBe('WEBSITE:abc');
  });
  it('spreads runs by ±10 % after an answer', () => {
    expect(minutes(nextRunAfterAnswer(now, 1000, () => 0.5))).toBe(1000);
    expect(minutes(nextRunAfterAnswer(now, 1000, () => 0))).toBe(900);
    expect(minutes(nextRunAfterAnswer(now, 1000, () => 1))).toBe(1100);
  });
  it('backs off after failures but never past the normal interval', () => {
    expect([1, 2, 3, 4].map((n) => minutes(nextRunAfterFailure(now, 720, n, 30)))).toEqual([
      30, 60, 120, 240,
    ]);
    expect(minutes(nextRunAfterFailure(now, 720, 10, 30))).toBe(720);
    expect(minutes(nextRunAfterFailure(now, 720, 1000, 30))).toBe(720);
  });
  it('rechecks soon, but never later than planned', () => {
    const planned = new Date(now.getTime() + 720 * 60_000);
    expect(minutes(nextRunForRecheck(now, planned, 30))).toBe(30);
    expect(minutes(nextRunForRecheck(now, new Date(now.getTime() + 10 * 60_000), 30))).toBe(10);
  });
  it('summarises health', () => {
    const base = { enabled: true, lastRunAt: now, consecutiveFailures: 0 };
    expect(scheduleHealth({ ...base, enabled: false })).toBe('PAUSED');
    expect(scheduleHealth({ ...base, lastRunAt: null })).toBe('PENDING');
    expect(scheduleHealth(base)).toBe('HEALTHY');
    expect(scheduleHealth({ ...base, consecutiveFailures: 2 })).toBe('DEGRADED');
    expect(scheduleHealth({ ...base, consecutiveFailures: 5 })).toBe('FAILING');
  });
});

describe('miss confirmation', () => {
  const later = (m: number) => new Date(now.getTime() + m * 60_000);
  it('counts the first miss, ignores a repeat of the same check and a too-quick second miss', () => {
    const first = registerMiss(NO_MISSES, 'c1', now);
    expect(first).toMatchObject({ missedChecks: 1, counted: true, lastMissedCheckId: 'c1' });
    expect(registerMiss(first, 'c1', later(60)).counted).toBe(false);
    expect(registerMiss(first, 'c2', later(2))).toMatchObject({ missedChecks: 1, counted: false });
  });
  it('counts a confirming check once the gap has passed', () => {
    const first = registerMiss(NO_MISSES, 'c1', now);
    const second = registerMiss(first, 'c2', later(DEFAULT_MISS_POLICY.minGapMinutes));
    expect(second).toMatchObject({ missedChecks: 2, counted: true, firstMissedAt: now });
    expect(registerMiss(second, 'c3', later(500)).missedChecks).toBe(3);
  });
});

describe('notification events', () => {
  const job = {
    jobId: 'j1',
    companyId: 'c1',
    companyName: 'Acme',
    title: 'Backend Engineer',
    location: 'Lahore',
  };
  const events: NotificationEvent[] = [
    { type: 'NEW_JOB', applicationUrl: null, ...job },
    { type: 'JOB_CLOSED', closedAt: now, reason: 'no longer listed', ...job },
    { type: 'JOB_CHANGED', fields: ['title'], contentHash: 'h1', ...job },
    {
      type: 'WEBSITE_CHANGED',
      companyId: 'c1',
      companyName: 'Acme',
      reason: 'DOMAIN_CHANGED',
      from: 'a.com',
      to: 'b.com',
    },
    {
      type: 'WEBSITE_CHANGED',
      companyId: 'c1',
      companyName: 'Acme',
      reason: 'UNAVAILABLE',
      since: now,
      failures: 3,
    },
  ];
  it('identifies each fact by a stable key', () => {
    const keys = events.map(dedupeKey);
    expect(new Set(keys).size).toBe(events.length);
    expect(events.map(dedupeKey)).toEqual(keys); // deterministic
    expect(keys[0]).toBe('job-new:j1');
    // a job that closes again later is a new fact; the same closure is not
    expect(
      dedupeKey({ ...events[1]!, closedAt: new Date(now.getTime() + 1000) } as NotificationEvent),
    ).not.toBe(keys[1]);
    expect(dedupeKey({ ...events[2]!, contentHash: 'h2' } as NotificationEvent)).not.toBe(keys[2]);
  });
  it('renders plain text, never markup', () => {
    const r = renderNotification({
      type: 'NEW_JOB',
      applicationUrl: null,
      ...job,
      title: 'Dev\n<script>x</script>   ',
    });
    expect(r.title).toBe('New job at Acme');
    expect(r.body).not.toContain('\n');
    expect(r.data).toMatchObject({ jobId: 'j1', companyId: 'c1' });
    expect(events.map((e) => renderNotification(e).type)).toEqual([
      'NEW_JOB',
      'JOB_CLOSED',
      'JOB_CHANGED',
      'WEBSITE_CHANGED',
      'WEBSITE_CHANGED',
    ]);
  });
  it('defaults: in-app on, email off', () => {
    expect(wants(undefined, 'in_app')).toBe(true);
    expect(wants(undefined, 'email')).toBe(false);
    expect(wants({ inApp: false, email: true }, 'in_app')).toBe(false);
    expect(wants({ inApp: false, email: true }, 'email')).toBe(true);
  });
});
