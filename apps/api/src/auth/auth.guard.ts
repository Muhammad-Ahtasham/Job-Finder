import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { IS_PUBLIC } from './decorators';
import { SessionCookieService } from './session-cookie.service';
import { SessionService } from './session.service';

/** Global guard: every route requires a valid session unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly cookies: SessionCookieService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const token = this.cookies.read(request);
    const resolved = token ? await this.sessions.resolve(token) : null;
    if (!resolved) {
      if (token) this.cookies.clear(response);
      throw new UnauthorizedException('Authentication required');
    }

    request.auth = resolved.context;
    if (resolved.rotated) {
      this.cookies.set(response, resolved.rotated.token, resolved.rotated.expiresAt);
    }
    return true;
  }
}
