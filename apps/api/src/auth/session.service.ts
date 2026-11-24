import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@jobfinder/database';
import { ENV, type Env } from '../config/env.token';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthContext, RequestMeta } from './auth.types';

/** After rotation the previous token keeps working briefly so parallel requests don't 401. */
const ROTATION_GRACE_MS = 30_000;
/** Don't write `lastSeenAt` on every request. */
const LAST_SEEN_RESOLUTION_MS = 60_000;

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export interface ResolvedSession {
  context: AuthContext;
  /** Present when the token was rotated; the caller must set the new cookie. */
  rotated?: IssuedToken;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Only the SHA-256 of a token is stored; the 256-bit random token is the secret. */
  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private newToken(): string {
    return randomBytes(32).toString('base64url');
  }

  async create(userId: string, meta: RequestMeta = {}): Promise<IssuedToken> {
    const token = this.newToken();
    const expiresAt = new Date(Date.now() + this.env.SESSION_ABSOLUTE_TTL_HOURS * 3_600_000);
    await this.prisma.client.session.create({
      data: {
        userId,
        tokenHash: SessionService.hashToken(token),
        expiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 512),
      },
    });
    return { token, expiresAt };
  }

  /**
   * Validates a presented token: absolute expiry, idle expiry, and rotation.
   * Returns null for unknown/expired sessions (expired rows are deleted).
   */
  async resolve(token: string): Promise<ResolvedSession | null> {
    const hash = SessionService.hashToken(token);
    const now = new Date();

    const session = await this.prisma.client.session.findFirst({
      where: {
        OR: [{ tokenHash: hash }, { previousTokenHash: hash, previousValidUntil: { gt: now } }],
      },
      include: { user: true },
    });
    if (!session) return null;

    const idleLimit = new Date(now.getTime() - this.env.SESSION_IDLE_TTL_HOURS * 3_600_000);
    if (session.expiresAt <= now || session.lastSeenAt <= idleLimit) {
      await this.prisma.client.session.deleteMany({ where: { id: session.id } });
      return null;
    }

    const context: AuthContext = {
      sessionId: session.id,
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        createdAt: session.user.createdAt,
      },
    };

    const viaPreviousToken = session.tokenHash !== hash;
    const rotateAfterMs = this.env.SESSION_ROTATE_AFTER_MINUTES * 60_000;
    let rotated: IssuedToken | undefined;
    const data: Prisma.SessionUpdateManyMutationInput = {};

    if (!viaPreviousToken && now.getTime() - session.rotatedAt.getTime() >= rotateAfterMs) {
      const token = this.newToken();
      data.tokenHash = SessionService.hashToken(token);
      data.previousTokenHash = hash;
      data.previousValidUntil = new Date(now.getTime() + ROTATION_GRACE_MS);
      data.rotatedAt = now;
      data.lastSeenAt = now;
      rotated = { token, expiresAt: session.expiresAt };
    } else if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_RESOLUTION_MS) {
      data.lastSeenAt = now;
    }

    if (Object.keys(data).length > 0) {
      // Compare-and-swap on the token hash: if a parallel request already rotated,
      // we lose the race and simply don't issue a new cookie (the old token is still
      // honoured through the grace window, and the winner's cookie is the live one).
      const updated = await this.prisma.client.session.updateMany({
        where: { id: session.id, tokenHash: session.tokenHash },
        data,
      });
      if (updated.count === 0) rotated = undefined;
    }

    return { context, rotated };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.client.session.deleteMany({ where: { id: sessionId } });
  }

  async revokeByToken(token: string): Promise<void> {
    const hash = SessionService.hashToken(token);
    await this.prisma.client.session.deleteMany({
      where: { OR: [{ tokenHash: hash }, { previousTokenHash: hash }] },
    });
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const { count } = await this.prisma.client.session.deleteMany({ where: { userId } });
    return count;
  }

  /** Housekeeping; invoked by the worker's maintenance queue. */
  async purgeExpired(): Promise<number> {
    const idleLimit = new Date(Date.now() - this.env.SESSION_IDLE_TTL_HOURS * 3_600_000);
    const { count } = await this.prisma.client.session.deleteMany({
      where: { OR: [{ expiresAt: { lte: new Date() } }, { lastSeenAt: { lte: idleLimit } }] },
    });
    return count;
  }
}
