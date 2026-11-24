import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionService } from '../src/auth/session.service';
import {
  cookieValue,
  createTestApp,
  newCredentials,
  setCookieLine,
  type TestContext,
} from './helpers';

let ctx: TestContext;
const cookie = (value: string) => `jf_session=${value}`;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

async function register(creds = newCredentials()) {
  const response = await request(ctx.server).post('/api/v1/auth/register').send(creds);
  return { creds, response, token: cookieValue(response) as string };
}

describe('registration', () => {
  it('creates the user, a personal workspace and an OWNER membership, and signs in', async () => {
    const { creds, response, token } = await register();

    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({ email: creds.email, name: creds.name });
    expect(response.body.user).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(response.body)).not.toContain(creds.password);
    expect(response.body.workspaces).toHaveLength(1);
    expect(response.body.workspaces[0]).toMatchObject({ isPersonal: true, role: 'OWNER' });

    // Persisted state
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: creds.email } });
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({
      where: { personalOwnerId: user.id },
    });
    expect(workspace.isPersonal).toBe(true);
    const membership = await ctx.prisma.workspaceMember.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    });
    expect(membership.role).toBe('OWNER');

    // The session cookie is hardened and only its hash is stored.
    const line = setCookieLine(response)!;
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
    expect(line).toMatch(/Path=\//i);
    expect(line).toMatch(/Expires=/i);
    const session = await ctx.prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.tokenHash).toBe(SessionService.hashToken(token));
    expect(session.tokenHash).not.toBe(token);
  });

  it('rejects duplicate emails regardless of case', async () => {
    const { creds } = await register();
    const duplicate = await request(ctx.server)
      .post('/api/v1/auth/register')
      .send({ ...creds, email: creds.email.toUpperCase() });
    expect(duplicate.status).toBe(409);
  });

  it('does not leave a half-created account when registration fails', async () => {
    const creds = newCredentials();
    await register(creds);
    const before = await ctx.prisma.workspace.count();
    await request(ctx.server).post('/api/v1/auth/register').send(creds);
    expect(await ctx.prisma.workspace.count()).toBe(before);
  });

  it('validates input strictly', async () => {
    const short = await request(ctx.server)
      .post('/api/v1/auth/register')
      .send({ ...newCredentials(), password: 'short' });
    expect(short.status).toBe(400);

    const extra = await request(ctx.server)
      .post('/api/v1/auth/register')
      .send({ ...newCredentials(), role: 'OWNER' });
    expect(extra.status).toBe(400);

    const badEmail = await request(ctx.server)
      .post('/api/v1/auth/register')
      .send({ ...newCredentials(), email: 'nope' });
    expect(badEmail.status).toBe(400);
  });
});

describe('login / me / logout', () => {
  it('logs in with valid credentials and issues a new session', async () => {
    const { creds, token: registerToken } = await register();
    const response = await request(ctx.server)
      .post('/api/v1/auth/login')
      .send({ email: creds.email.toUpperCase(), password: creds.password });
    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe(creds.email);
    const token = cookieValue(response)!;
    expect(token).toBeTruthy();
    expect(token).not.toBe(registerToken);

    const me = await request(ctx.server).get('/api/v1/auth/me').set('Cookie', cookie(token));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(creds.email);
  });

  it('returns the same 401 for a wrong password and an unknown email', async () => {
    const { creds } = await register();
    const wrongPassword = await request(ctx.server)
      .post('/api/v1/auth/login')
      .send({ email: creds.email, password: 'definitely-the-wrong-password' });
    const unknownEmail = await request(ctx.server)
      .post('/api/v1/auth/login')
      .send({ email: newCredentials().email, password: creds.password });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
    expect(setCookieLine(wrongPassword)).toBeUndefined();
  });

  it('retires the presented session on login (no session fixation)', async () => {
    const { creds, token: old } = await register();
    const login = await request(ctx.server)
      .post('/api/v1/auth/login')
      .set('Cookie', cookie(old))
      .send({ email: creds.email, password: creds.password });
    expect(login.status).toBe(200);
    const stale = await request(ctx.server).get('/api/v1/auth/me').set('Cookie', cookie(old));
    expect(stale.status).toBe(401);
  });

  it('requires authentication for /me', async () => {
    expect((await request(ctx.server).get('/api/v1/auth/me')).status).toBe(401);
    const garbage = await request(ctx.server)
      .get('/api/v1/auth/me')
      .set('Cookie', cookie('garbage'));
    expect(garbage.status).toBe(401);
  });

  it('logs out: revokes the session server-side and clears the cookie', async () => {
    const { token } = await register();
    const response = await request(ctx.server)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookie(token));
    expect(response.status).toBe(204);
    expect(setCookieLine(response)).toMatch(/jf_session=;/);

    const row = await ctx.prisma.session.findUnique({
      where: { tokenHash: SessionService.hashToken(token) },
    });
    expect(row).toBeNull();
    // Replaying the old cookie must fail.
    const replay = await request(ctx.server).get('/api/v1/auth/me').set('Cookie', cookie(token));
    expect(replay.status).toBe(401);
  });

  it('logout is idempotent without a session', async () => {
    expect((await request(ctx.server).post('/api/v1/auth/logout')).status).toBe(204);
  });
});

describe('session lifecycle', () => {
  it('rotates the token after the rotation interval and honours the old one briefly', async () => {
    const { token: original } = await register();
    const hash = SessionService.hashToken(original);
    await ctx.prisma.session.update({
      where: { tokenHash: hash },
      data: { rotatedAt: new Date(Date.now() - 2 * 3_600_000) },
    });

    const first = await request(ctx.server).get('/api/v1/auth/me').set('Cookie', cookie(original));
    expect(first.status).toBe(200);
    const rotated = cookieValue(first);
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(original);

    // New token works; old token still works inside the grace window without re-rotating.
    expect(
      (await request(ctx.server).get('/api/v1/auth/me').set('Cookie', cookie(rotated!))).status,
    ).toBe(200);
    const graceful = await request(ctx.server)
      .get('/api/v1/auth/me')
      .set('Cookie', cookie(original));
    expect(graceful.status).toBe(200);
    expect(setCookieLine(graceful)).toBeUndefined();

    // Once the grace window passes the old token is dead.
    await ctx.prisma.session.update({
      where: { tokenHash: SessionService.hashToken(rotated!) },
      data: { previousValidUntil: new Date(Date.now() - 1000) },
    });
    expect(
      (await request(ctx.server).get('/api/v1/auth/me').set('Cookie', cookie(original))).status,
    ).toBe(401);
  });

  it('does not rotate a fresh session', async () => {
    const { token } = await register();
    const response = await request(ctx.server).get('/api/v1/auth/me').set('Cookie', cookie(token));
    expect(response.status).toBe(200);
    expect(setCookieLine(response)).toBeUndefined();
  });

  it('rejects and deletes sessions past their absolute expiry', async () => {
    const { token } = await register();
    const tokenHash = SessionService.hashToken(token);
    await ctx.prisma.session.update({
      where: { tokenHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      (await request(ctx.server).get('/api/v1/auth/me').set('Cookie', cookie(token))).status,
    ).toBe(401);
    expect(await ctx.prisma.session.findUnique({ where: { tokenHash } })).toBeNull();
  });

  it('rejects sessions idle for longer than the idle timeout', async () => {
    const { token } = await register();
    await ctx.prisma.session.update({
      where: { tokenHash: SessionService.hashToken(token) },
      data: { lastSeenAt: new Date(Date.now() - 25 * 3_600_000) },
    });
    expect(
      (await request(ctx.server).get('/api/v1/auth/me').set('Cookie', cookie(token))).status,
    ).toBe(401);
  });

  it('purgeExpired removes dead sessions only', async () => {
    const { token: live } = await register();
    const { token: dead } = await register();
    await ctx.prisma.session.update({
      where: { tokenHash: SessionService.hashToken(dead) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const removed = await ctx.app.get(SessionService).purgeExpired();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(
      await ctx.prisma.session.findUnique({ where: { tokenHash: SessionService.hashToken(live) } }),
    ).not.toBeNull();
    expect(
      await ctx.prisma.session.findUnique({ where: { tokenHash: SessionService.hashToken(dead) } }),
    ).toBeNull();
  });
});

describe('CSRF origin guard', () => {
  it('rejects state-changing requests from an unexpected Origin', async () => {
    const { creds, token } = await register();
    const login = await request(ctx.server)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: creds.email, password: creds.password });
    expect(login.status).toBe(403);

    const logout = await request(ctx.server)
      .post('/api/v1/auth/logout')
      .set('Origin', 'https://evil.example')
      .set('Cookie', cookie(token));
    expect(logout.status).toBe(403);
    // …and the session survived the forged request.
    expect(
      (await request(ctx.server).get('/api/v1/auth/me').set('Cookie', cookie(token))).status,
    ).toBe(200);
  });

  it('allows the configured web origin', async () => {
    const { creds } = await register();
    const login = await request(ctx.server)
      .post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3000')
      .send({ email: creds.email, password: creds.password });
    expect(login.status).toBe(200);
  });
});
