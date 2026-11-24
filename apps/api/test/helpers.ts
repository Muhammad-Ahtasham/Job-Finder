import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Response } from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService['client'];
  server: ReturnType<INestApplication['getHttpServer']>;
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  configureApp(app);
  await app.init();
  return { app, prisma: app.get(PrismaService).client, server: app.getHttpServer() };
}

export const newCredentials = () => ({
  email: `user-${randomUUID()}@example.test`,
  password: 'correct-horse-battery-staple',
  name: 'Test User',
});

/** Extract the raw `Set-Cookie` header line for a cookie name (or undefined). */
export function setCookieLine(response: Response, name = 'jf_session'): string | undefined {
  const header = response.headers['set-cookie'] as unknown as string[] | undefined;
  return header?.find((line) => line.startsWith(`${name}=`));
}

export function cookieValue(response: Response, name = 'jf_session'): string | undefined {
  const line = setCookieLine(response, name);
  if (!line) return undefined;
  return line.slice(name.length + 1).split(';', 1)[0];
}
