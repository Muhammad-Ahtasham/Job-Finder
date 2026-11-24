import { INestApplication, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { ENV, type Env } from './config/env.token';

/** Shared by main.ts and the e2e tests so tests exercise the real HTTP configuration. */
export function configureApp(app: INestApplication): void {
  const env = app.get<Env>(ENV);
  const express = app as NestExpressApplication;

  app.useLogger(app.get(Logger));
  // JSON-only API: CSP adds nothing here and would break the Swagger UI assets.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  express.disable('x-powered-by');

  app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
  app.enableVersioning({ type: VersioningType.URI });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  if (env.SWAGGER_ENABLED) {
    const config = new DocumentBuilder()
      .setTitle('Company Discovery & Job Intelligence Platform API')
      .setDescription('Phase 1: authentication, workspaces and health.')
      .setVersion('0.1.0')
      .addCookieAuth(env.SESSION_COOKIE_NAME)
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config), {
      jsonDocumentUrl: 'docs/json',
    });
  }
}
