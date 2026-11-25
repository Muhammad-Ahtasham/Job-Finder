import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { STRICT_THROTTLE } from './auth/decorators';
import { OriginGuard } from './auth/origin.guard';
import { ConfigModule } from './config/config.module';
import { ENV, type Env } from './config/env.token';
import { CompaniesModule } from './companies/companies.module';
import { DirectoryModule } from './directory/directory.module';
import { ExportsModule } from './exports/exports.module';
import { HealthModule } from './health/health.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { ProjectsModule } from './projects/projects.module';
import { QueueModule } from './queue/queue.module';
import { RunsModule } from './runs/runs.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          genReqId: (request, response) => {
            const incoming = request.headers['x-request-id'];
            const id =
              typeof incoming === 'string' && /^[\w.-]{1,64}$/.test(incoming)
                ? incoming
                : randomUUID();
            response.setHeader('x-request-id', id);
            return id;
          },
          // Never log credentials or session cookies.
          redact: {
            paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
            censor: '[redacted]',
          },
          autoLogging: { ignore: (request) => (request.url ?? '').startsWith('/health/live') },
          transport:
            env.NODE_ENV === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
              : undefined,
        },
      }),
    }),
    // Two named limiters. `global` protects every route; `auth` additionally applies
    // only to handlers tagged @StrictThrottle() (login/register). In-memory storage is
    // per-process — move to Redis storage before running multiple API replicas.
    ThrottlerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        throttlers: [
          { name: 'global', ttl: 60_000, limit: 600 },
          {
            name: 'auth',
            ttl: 60_000,
            limit: env.AUTH_RATE_LIMIT_PER_MINUTE,
            skipIf: (context) =>
              !new Reflector().get<boolean>(STRICT_THROTTLE, context.getHandler()),
          },
        ],
      }),
    }),
    PrismaModule,
    RedisModule,
    QueueModule,
    AuthModule,
    WorkspacesModule,
    ProjectsModule,
    RunsModule,
    CompaniesModule,
    IntelligenceModule,
    DirectoryModule,
    ExportsModule,
    HealthModule,
  ],
  providers: [
    // Order matters: rate-limit → CSRF origin check → authentication.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
