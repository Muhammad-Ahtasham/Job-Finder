import request from 'supertest';
import { WorkspaceRole } from '@jobfinder/database';
import { WORKSPACE_ROLES } from '@jobfinder/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieValue, createTestApp, newCredentials, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

const register = async () => {
  const creds = newCredentials();
  const response = await request(ctx.server).post('/api/v1/auth/register').send(creds);
  return { creds, cookie: `jf_session=${cookieValue(response)}` };
};

describe('workspaces', () => {
  it('lists only the caller’s workspaces', async () => {
    const a = await register();
    const b = await register();

    const listA = await request(ctx.server).get('/api/v1/workspaces').set('Cookie', a.cookie);
    const listB = await request(ctx.server).get('/api/v1/workspaces').set('Cookie', b.cookie);
    expect(listA.status).toBe(200);
    expect(listA.body.workspaces).toHaveLength(1);
    expect(listA.body.workspaces[0]).toMatchObject({ isPersonal: true, role: 'OWNER' });
    expect(listA.body.workspaces[0].id).not.toBe(listB.body.workspaces[0].id);
  });

  it('requires authentication', async () => {
    expect((await request(ctx.server).get('/api/v1/workspaces')).status).toBe(401);
  });

  it('enforces one personal workspace per user at the database level', async () => {
    const { creds } = await register();
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: creds.email } });
    await expect(
      ctx.prisma.workspace.create({
        data: { name: 'dup', slug: `dup-${user.id}`, isPersonal: true, personalOwnerId: user.id },
      }),
    ).rejects.toThrow();
  });

  it('keeps the contracts role list in sync with the Prisma enum', () => {
    expect(Object.values(WorkspaceRole).sort()).toEqual([...WORKSPACE_ROLES].sort());
  });
});
