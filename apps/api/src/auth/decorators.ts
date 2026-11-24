import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from './auth.types';

export const IS_PUBLIC = 'isPublic';
/** Opt a route out of the global AuthGuard. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const STRICT_THROTTLE = 'strictThrottle';
/** Apply the stricter (credential-stuffing) rate limit to a route. */
export const StrictThrottle = () => SetMetadata(STRICT_THROTTLE, true);

/** Injects the authenticated context set by AuthGuard. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const request = ctx.switchToHttp().getRequest<Request>();
    if (!request.auth) throw new Error('CurrentAuth used on a route without AuthGuard');
    return request.auth;
  },
);
