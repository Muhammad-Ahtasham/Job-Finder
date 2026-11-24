import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { ENV, type Env } from '../config/env.token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth (on top of SameSite=Lax): browsers always send `Origin` on
 * cross-site state-changing requests, so a present-but-unexpected Origin is rejected.
 * Requests with no Origin/Referer (curl, server-to-server) are not browser CSRF vectors.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;

    const origin = request.headers.origin ?? this.originOf(request.headers.referer);
    if (!origin) return true;
    if (this.env.WEB_ORIGIN.includes(origin)) return true;
    throw new ForbiddenException('Cross-origin request rejected');
  }

  private originOf(referer: string | undefined): string | undefined {
    if (!referer) return undefined;
    try {
      return new URL(referer).origin;
    } catch {
      return 'invalid';
    }
  }
}
