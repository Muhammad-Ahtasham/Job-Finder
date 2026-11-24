import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { ENV, type Env } from './config/env.token';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app);

  const env = app.get<Env>(ENV);
  await app.listen(env.API_PORT, env.API_HOST);
  app.get(Logger).log(`API listening on http://${env.API_HOST}:${env.API_PORT}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  // Env validation errors land here with a readable list of problems.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
