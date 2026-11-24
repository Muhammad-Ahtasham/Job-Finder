import { Global, Module } from '@nestjs/common';
import { loadApiEnv } from '@jobfinder/config';
import { ENV } from './env.token';

/** Validates the environment once at boot (fails fast) and exposes it via DI. */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadApiEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
