import { Inject, Injectable } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { ENV, type Env } from '../config/env.token';

@Injectable()
export class SessionCookieService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  private baseOptions(): CookieOptions {
    return {
      httpOnly: true, // not readable from JS → XSS cannot steal the session
      secure: this.env.SESSION_COOKIE_SECURE,
      sameSite: 'lax', // blocks cross-site POSTs; complemented by the Origin guard
      path: '/',
    };
  }

  read(request: Request): string | undefined {
    const value: unknown = request.cookies?.[this.env.SESSION_COOKIE_NAME];
    return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
  }

  set(response: Response, token: string, expiresAt: Date): void {
    response.cookie(this.env.SESSION_COOKIE_NAME, token, {
      ...this.baseOptions(),
      expires: expiresAt,
    });
  }

  clear(response: Response): void {
    response.clearCookie(this.env.SESSION_COOKIE_NAME, this.baseOptions());
  }
}
