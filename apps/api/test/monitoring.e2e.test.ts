import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieValue, createTestApp, newCredentials, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

interface Actor {
  cookie: string;
  userId: string;
  workspaceId: string;
}
async function newActor(): Promise<Actor> {
  const r = await request(ctx.server).post('/api/v1/auth/register').send(newCredentials());
  return {
    cookie: `jf_session=${cookieValue(r)}`,
    userId: r.body.user.id,
    workspaceId: r.body.workspaces[0].id,
  };
}
const call = (
  a: Actor,
  method: 'get' | 'post' | 'put' | 'patch',
  path: string,
  workspaceId?: string,
) => {
  const req = request(ctx.server)[method](`/api/v1${path}`).set('Cookie', a.cookie);
  return workspaceId ? req.set('X-Workspace-Id', workspaceId) : req;
};

/** A company with an ATS board and a website, and (optionally) the schedules a run would create. */
async function seed(a: Actor, withSchedules = true) {
  const name = `Acme ${randomUUID().slice(0, 6)}`;
  const company = await ctx.prisma.company.create({
    data: {
      workspaceId: a.workspaceId,
      displayName: name,
      nameKey: name.toLowerCase(),
      coreName: name.toLowerCase(),
      nameTokens: [name.toLowerCase()],
      coreTokens: [name.toLowerCase()],
      country: 'PK',
      website: 'https://acme.example/',
      websiteStatus: 'VERIFIED',
    },
  });
  const source = await ctx.prisma.jobSource.create({
    data: {
      workspaceId: a.workspaceId,
      companyId: company.id,
      providerId: 'greenhouse',
      boardKey: 'acme',
      boardUrl: 'https://boards.greenhouse.io/acme',
    },
  });
  const make = (
    kind: 'ATS_BOARD' | 'WEBSITE',
    id: string,
    jobSourceId: string | null,
    interval: number,
  ) =>
    ctx.prisma.monitoringSchedule.create({
      data: {
        workspaceId: a.workspaceId,
        companyId: company.id,
        jobSourceId,
        kind,
        scopeKey: `${kind}:${id}`,
        intervalMinutes: interval,
        nextRunAt: new Date(Date.now() + interval * 60_000),
      },
    });
  const ats = withSchedules ? await make('ATS_BOARD', source.id, source.id, 720) : null;
  const website = withSchedules ? await make('WEBSITE', company.id, null, 10_080) : null;
  return { company, source, ats, website };
}

describe('GET /monitoring', () => {
  it('lists schedules with health, filters them, and is workspace scoped', async () => {
    const [a, b] = [await newActor(), await newActor()];
    const { company, ats } = await seed(a);
    await seed(b);
    await ctx.prisma.monitoringSchedule.update({
      where: { id: ats!.id },
      data: {
        lastRunAt: new Date(),
        lastSuccessAt: new Date(Date.now() - 3_600_000),
        consecutiveFailures: 2,
        lastErrorCode: 'HTTP_500',
        lastErrorMessage: 'the vendor is down',
        lastErrorAt: new Date(),
      },
    });

    const all = await call(a, 'get', '/monitoring');
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(2);
    const board = all.body.items.find((s: { kind: string }) => s.kind === 'ATS_BOARD');
    expect(board).toMatchObject({
      id: ats!.id,
      companyId: company.id,
      enabled: true,
      intervalMinutes: 720,
      consecutiveFailures: 2,
      health: 'DEGRADED',
      source: { providerId: 'greenhouse', url: 'https://boards.greenhouse.io/acme' },
      lastError: { code: 'HTTP_500', message: 'the vendor is down' },
    });
    expect(board.lastSuccessAt).not.toBeNull();
    expect(all.body.items.find((s: { kind: string }) => s.kind === 'WEBSITE')).toMatchObject({
      source: null,
      health: 'PENDING',
      lastError: null,
    });

    expect((await call(a, 'get', '/monitoring?kind=WEBSITE')).body.items).toHaveLength(1);
    expect(
      (await call(a, 'get', `/monitoring?companyId=${company.id}&enabled=true`)).body.items,
    ).toHaveLength(2);
    expect((await call(a, 'get', '/monitoring?enabled=false')).body.items).toHaveLength(0);
    expect((await call(a, 'get', '/monitoring?kind=NOPE')).status).toBe(400);
    const page = await call(a, 'get', '/monitoring?limit=1');
    expect(page.body.nextCursor).not.toBeNull();
    expect(
      (await call(a, 'get', `/monitoring?limit=1&cursor=${page.body.nextCursor}`)).body.items,
    ).toHaveLength(1);
    expect((await request(ctx.server).get('/api/v1/monitoring')).status).toBe(401);
  });
});

describe('PATCH /monitoring/:id and POST /monitoring/:id/run', () => {
  it('enables, disables and re-times a schedule, with validation', async () => {
    const a = await newActor();
    const { ats } = await seed(a);

    const off = await call(a, 'patch', `/monitoring/${ats!.id}`).send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ enabled: false, health: 'PAUSED' });
    expect((await call(a, 'post', `/monitoring/${ats!.id}/run`)).status).toBe(409);

    const on = await call(a, 'patch', `/monitoring/${ats!.id}`).send({
      enabled: true,
      intervalMinutes: 120,
    });
    expect(on.body).toMatchObject({ enabled: true, intervalMinutes: 120 });
    // a shorter interval brings the next run forward
    expect((new Date(on.body.nextRunAt).getTime() - Date.now()) / 60_000).toBeLessThanOrEqual(121);
    // a longer one leaves it where it is
    const longer = await call(a, 'patch', `/monitoring/${ats!.id}`).send({ intervalMinutes: 1440 });
    expect(longer.body.intervalMinutes).toBe(1440);
    expect(new Date(longer.body.nextRunAt).getTime()).toBe(new Date(on.body.nextRunAt).getTime());

    for (const bad of [
      {},
      { intervalMinutes: 30 },
      { intervalMinutes: 99_999 },
      { intervalMinutes: 90.5 },
      { enabled: 'yes' },
      { other: 1 },
    ]) {
      expect(
        (await call(a, 'patch', `/monitoring/${ats!.id}`).send(bad)).status,
        JSON.stringify(bad),
      ).toBe(400);
    }

    const run = await call(a, 'post', `/monitoring/${ats!.id}/run`);
    expect(run.status).toBe(202);
    expect(new Date(run.body.nextRunAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('never touches another workspace’s schedule', async () => {
    const [a, b] = [await newActor(), await newActor()];
    const { ats } = await seed(a);
    expect((await call(b, 'patch', `/monitoring/${ats!.id}`).send({ enabled: false })).status).toBe(
      404,
    );
    expect((await call(b, 'post', `/monitoring/${ats!.id}/run`)).status).toBe(404);
    expect(
      (await call(a, 'get', '/monitoring')).body.items.find((s: { id: string }) => s.id === ats!.id)
        .enabled,
    ).toBe(true);
  });
});

describe('company monitoring switch', () => {
  it('turns every schedule of a company off and on, creating missing ones', async () => {
    const [a, b] = [await newActor(), await newActor()];
    const { company, website } = await seed(a, false);

    // nothing scheduled yet: enabling creates the schedules from the company's sources
    const first = await call(a, 'get', `/companies/${company.id}/monitoring`);
    expect(first.body).toMatchObject({
      companyId: company.id,
      enabled: false,
      schedules: [],
      recentWebsiteChecks: [],
    });
    const on = await call(a, 'put', `/companies/${company.id}/monitoring`).send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);
    expect(on.body.schedules.map((s: { kind: string }) => s.kind).sort()).toEqual([
      'ATS_BOARD',
      'WEBSITE',
    ]);
    expect(
      on.body.schedules.find((s: { kind: string }) => s.kind === 'ATS_BOARD').intervalMinutes,
    ).toBe(720);
    expect(
      on.body.schedules.find((s: { kind: string }) => s.kind === 'WEBSITE').intervalMinutes,
    ).toBe(10_080);

    const off = await call(a, 'put', `/companies/${company.id}/monitoring`).send({
      enabled: false,
    });
    expect(off.body.enabled).toBe(false);
    expect(
      off.body.schedules.every(
        (s: { enabled: boolean; health: string }) => !s.enabled && s.health === 'PAUSED',
      ),
    ).toBe(true);
    expect(await ctx.prisma.monitoringSchedule.count({ where: { companyId: company.id } })).toBe(2); // not duplicated
    expect(website).toBeNull();

    // turning it back on re-uses the same schedules
    await call(a, 'put', `/companies/${company.id}/monitoring`).send({ enabled: true });
    expect(
      await ctx.prisma.monitoringSchedule.count({
        where: { companyId: company.id, enabled: true },
      }),
    ).toBe(2);

    expect((await call(a, 'put', `/companies/${company.id}/monitoring`).send({})).status).toBe(400);
    expect(
      (await call(a, 'put', `/companies/${company.id}/monitoring`).send({ enabled: 1 })).status,
    ).toBe(400);
    expect(
      (await call(b, 'put', `/companies/${company.id}/monitoring`).send({ enabled: false })).status,
    ).toBe(404);
    expect((await call(b, 'get', `/companies/${company.id}/monitoring`)).status).toBe(404);
  });

  it('shows recent website checks', async () => {
    const a = await newActor();
    const { company } = await seed(a);
    await ctx.prisma.websiteCheck.createMany({
      data: [
        {
          workspaceId: a.workspaceId,
          companyId: company.id,
          url: 'https://acme.example/',
          outcome: 'OK',
          httpStatus: 200,
          finalDomain: 'acme.example',
        },
        {
          workspaceId: a.workspaceId,
          companyId: company.id,
          url: 'https://acme.example/',
          outcome: 'FAILED',
          errorCode: 'TIMEOUT',
          errorMessage: 'timed out',
        },
      ],
    });
    const res = await call(a, 'get', `/companies/${company.id}/monitoring`);
    expect(res.body.recentWebsiteChecks.map((c: { outcome: string }) => c.outcome)).toEqual([
      'FAILED',
      'OK',
    ]);
    expect(res.body.recentWebsiteChecks[0]).toMatchObject({ errorCode: 'TIMEOUT' });
  });
});

describe('notifications', () => {
  async function member(a: Actor): Promise<Actor> {
    const other = await newActor();
    await ctx.prisma.workspaceMember.create({
      data: { workspaceId: a.workspaceId, userId: other.userId, role: 'MEMBER' },
    });
    return { ...other, workspaceId: a.workspaceId };
  }
  const note = (a: Actor, userId: string, over: Record<string, unknown> = {}) =>
    ctx.prisma.notification.create({
      data: {
        workspaceId: a.workspaceId,
        userId,
        type: 'NEW_JOB',
        dedupeKey: `k-${randomUUID()}`,
        title: 'New job at Acme',
        body: 'Backend Engineer (Lahore)',
        data: { jobId: 'j', companyId: 'c' },
        deliveredChannels: ['in_app'],
        ...over,
      },
    });

  it('lists only your own in-app notifications, newest first, with an unread count', async () => {
    const a = await newActor();
    const b = await member(a);
    const first = await note(a, a.userId);
    const second = await note(a, a.userId, { type: 'JOB_CLOSED' });
    await note(a, b.userId);
    await note(a, a.userId, { deliveredChannels: [] }); // email-only: not in the feed
    await ctx.prisma.notification.update({ where: { id: first.id }, data: { readAt: new Date() } });

    const list = await call(a, 'get', '/notifications');
    expect(list.status).toBe(200);
    expect(list.body.items.map((n: { id: string }) => n.id)).toEqual([second.id, first.id]);
    expect(list.body.unreadCount).toBe(1);
    expect(list.body.items[0]).toMatchObject({
      type: 'JOB_CLOSED',
      title: 'New job at Acme',
      data: { jobId: 'j' },
      readAt: null,
    });

    expect(
      (await call(a, 'get', '/notifications?unread=true')).body.items.map(
        (n: { id: string }) => n.id,
      ),
    ).toEqual([second.id]);
    expect((await call(a, 'get', '/notifications?type=NEW_JOB')).body.items).toHaveLength(1);
    const page = await call(a, 'get', '/notifications?limit=1');
    expect(page.body.nextCursor).toBe(second.id);
    expect((await call(a, 'get', '/notifications?type=BOGUS')).status).toBe(400);
    expect((await call(b, 'get', '/notifications', b.workspaceId)).body.unreadCount).toBe(1);
    // the same user in a workspace they are not in sees nothing and is refused
    const stranger = await newActor();
    expect((await call(stranger, 'get', '/notifications', a.workspaceId)).status).toBe(403);
    expect((await request(ctx.server).get('/api/v1/notifications')).status).toBe(401);
  });

  it('marks notifications read, one or all, and only your own', async () => {
    const a = await newActor();
    const b = await member(a);
    const mine = await note(a, a.userId);
    await note(a, a.userId);
    const theirs = await note(a, b.userId);

    const one = await call(a, 'post', `/notifications/${mine.id}/read`);
    expect(one.status).toBe(200);
    expect(one.body.readAt).not.toBeNull();
    expect((await call(a, 'post', `/notifications/${mine.id}/read`)).status).toBe(200); // idempotent
    expect((await call(a, 'post', `/notifications/${theirs.id}/read`)).status).toBe(404);
    expect((await call(a, 'post', '/notifications/not-a-uuid/read')).status).toBe(400);

    expect((await call(a, 'post', '/notifications/read-all')).body).toEqual({ updated: 1 });
    expect((await call(a, 'get', '/notifications')).body.unreadCount).toBe(0);
    expect((await call(b, 'get', '/notifications', b.workspaceId)).body.unreadCount).toBe(1); // untouched
    expect((await call(a, 'post', '/notifications/read-all')).body).toEqual({ updated: 0 });
  });

  it('keeps notification preferences per member, with defaults', async () => {
    const a = await newActor();
    const defaults = await call(a, 'get', '/notification-preferences');
    expect(defaults.body.items).toEqual([
      { type: 'NEW_JOB', inApp: true, email: false },
      { type: 'JOB_CLOSED', inApp: true, email: false },
      { type: 'JOB_CHANGED', inApp: true, email: false },
      { type: 'WEBSITE_CHANGED', inApp: true, email: false },
    ]);

    const updated = await call(a, 'put', '/notification-preferences').send({
      preferences: [
        { type: 'NEW_JOB', email: true },
        { type: 'JOB_CHANGED', inApp: false },
      ],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.items).toEqual([
      { type: 'NEW_JOB', inApp: true, email: true },
      { type: 'JOB_CLOSED', inApp: true, email: false },
      { type: 'JOB_CHANGED', inApp: false, email: false },
      { type: 'WEBSITE_CHANGED', inApp: true, email: false },
    ]);
    // a partial update keeps the rest
    const again = await call(a, 'put', '/notification-preferences').send({
      preferences: [{ type: 'NEW_JOB', inApp: false }],
    });
    expect(again.body.items[0]).toEqual({ type: 'NEW_JOB', inApp: false, email: true });

    const other = await newActor();
    expect((await call(other, 'get', '/notification-preferences')).body.items[0]).toEqual({
      type: 'NEW_JOB',
      inApp: true,
      email: false,
    });
    for (const bad of [
      {},
      { preferences: [] },
      { preferences: [{ type: 'NOPE' }] },
      { preferences: [{ type: 'NEW_JOB', sms: true }] },
    ]) {
      expect(
        (await call(a, 'put', '/notification-preferences').send(bad)).status,
        JSON.stringify(bad),
      ).toBe(400);
    }
  });
});
