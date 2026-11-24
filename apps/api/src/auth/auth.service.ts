import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { LoginRequest, MeResponse, RegisterRequest } from '@jobfinder/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import type { AuthUser, RequestMeta } from './auth.types';
import { PasswordService } from './password.service';
import { SessionService, type IssuedToken } from './session.service';

export interface AuthResult {
  me: MeResponse;
  session: IssuedToken;
}

const INVALID_CREDENTIALS = 'Invalid email or password';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async register(input: RegisterRequest, meta: RequestMeta): Promise<AuthResult> {
    const passwordHash = await this.passwords.hash(input.password);

    let user: AuthUser;
    try {
      user = await this.prisma.client.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { email: input.email, name: input.name, passwordHash },
        });
        await this.workspaces.createPersonalWorkspace(tx, created);
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Email is already registered');
      throw error;
    }

    const session = await this.sessions.create(user.id, meta);
    this.logger.log({ userId: user.id }, 'User registered');
    return { me: await this.buildMe(user), session };
  }

  async login(input: LoginRequest, meta: RequestMeta, previousToken?: string): Promise<AuthResult> {
    const user = await this.prisma.client.user.findUnique({ where: { email: input.email } });

    if (!user) {
      await this.passwords.verifyAgainstDummy(input.password);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    if (!(await this.passwords.verify(user.passwordHash, input.password))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (this.passwords.needsRehash(user.passwordHash)) {
      const passwordHash = await this.passwords.hash(input.password);
      await this.prisma.client.user.update({ where: { id: user.id }, data: { passwordHash } });
    }

    // Always issue a fresh session on login (prevents session fixation) and retire
    // whichever session the browser was presenting.
    if (previousToken) await this.sessions.revokeByToken(previousToken);
    const session = await this.sessions.create(user.id, meta);
    this.logger.log({ userId: user.id }, 'User logged in');
    return { me: await this.buildMe(user), session };
  }

  /** Idempotent: unknown / already-revoked tokens are fine. */
  async logout(token: string | undefined): Promise<void> {
    if (token) await this.sessions.revokeByToken(token);
  }

  async me(user: AuthUser): Promise<MeResponse> {
    return this.buildMe(user);
  }

  private async buildMe(user: AuthUser): Promise<MeResponse> {
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt.toISOString(),
      },
      workspaces: await this.workspaces.listForUser(user.id),
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
