import { Controller, Get, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  liveResponseSchema,
  readyResponseSchema,
  type LiveResponse,
  type ReadyResponse,
} from '@jobfinder/contracts';
import { Public } from '../auth/decorators';
import { openApiSchema } from '../common/openapi';
import { HealthService } from './health.service';

/** Unversioned and outside the /api prefix (see app.setup.ts) so probes stay stable. */
@ApiTags('health')
@Public()
@SkipThrottle({ global: true, auth: true })
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: the process is up. Never touches dependencies. */
  @Get('live')
  @ApiOkResponse({ schema: openApiSchema(liveResponseSchema) })
  live(): LiveResponse {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL and Redis reachable (503 if not); worker status is informational. */
  @Get('ready')
  @ApiOkResponse({ schema: openApiSchema(readyResponseSchema) })
  @ApiServiceUnavailableResponse({ schema: openApiSchema(readyResponseSchema) })
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadyResponse> {
    const result = await this.health.ready();
    if (result.status === 'error') response.status(HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
