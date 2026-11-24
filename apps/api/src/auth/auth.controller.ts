import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  loginRequestSchema,
  meResponseSchema,
  registerRequestSchema,
  type LoginRequest,
  type MeResponse,
  type RegisterRequest,
} from '@jobfinder/contracts';
import { openApiSchema } from '../common/openapi';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthContext, RequestMeta } from './auth.types';
import { AuthService } from './auth.service';
import { CurrentAuth, Public, StrictThrottle } from './decorators';
import { SessionCookieService } from './session-cookie.service';

const requestMeta = (request: Request): RequestMeta => ({
  ip: request.ip,
  userAgent: request.headers['user-agent'],
});

/** Thin HTTP layer: validation + cookies only; all logic lives in AuthService. */
@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: SessionCookieService,
  ) {}

  @Public()
  @StrictThrottle()
  @Post('register')
  @ApiBody({ schema: openApiSchema(registerRequestSchema, 'input') })
  @ApiCreatedResponse({
    schema: openApiSchema(meResponseSchema),
    description: 'Registered and signed in',
  })
  @ApiConflictResponse({ description: 'Email already registered' })
  @ApiTooManyRequestsResponse()
  async register(
    @Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MeResponse> {
    const { me, session } = await this.auth.register(body, requestMeta(request));
    this.cookies.set(response, session.token, session.expiresAt);
    return me;
  }

  @Public()
  @StrictThrottle()
  @Post('login')
  @HttpCode(200)
  @ApiBody({ schema: openApiSchema(loginRequestSchema, 'input') })
  @ApiOkResponse({ schema: openApiSchema(meResponseSchema) })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password' })
  @ApiTooManyRequestsResponse()
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MeResponse> {
    const { me, session } = await this.auth.login(
      body,
      requestMeta(request),
      this.cookies.read(request),
    );
    this.cookies.set(response, session.token, session.expiresAt);
    return me;
  }

  /** Public + idempotent: logging out with an expired/missing session still succeeds. */
  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Session revoked and cookie cleared' })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(this.cookies.read(request));
    this.cookies.clear(response);
  }

  @Get('me')
  @ApiCookieAuth()
  @ApiOkResponse({ schema: openApiSchema(meResponseSchema) })
  @ApiUnauthorizedResponse()
  me(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    return this.auth.me(auth.user);
  }
}
