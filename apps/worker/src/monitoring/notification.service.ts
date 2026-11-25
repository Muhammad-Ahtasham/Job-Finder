import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@jobfinder/database';
import {
  dedupeKey,
  renderNotification,
  UnconfiguredEmailChannel,
  wants,
  type NotificationChannel,
  type NotificationEvent,
} from '@jobfinder/monitoring';
import { PRISMA } from '../infrastructure.module';
import { NOTIFICATION_CHANNELS } from './monitoring.tokens';

export interface EmitResult {
  /** Notifications that did not exist yet. */
  created: number;
  /** Recipient/event pairs that were already notified (same dedupe key). */
  duplicates: number;
}

/**
 * Turns events into notifications for the members of a workspace who want them.
 *
 * Idempotent: a notification is identified by (workspace, user, dedupe key), enforced by a
 * UNIQUE constraint. Reporting the same event again — a retried check, a re-run, two workers
 * racing — inserts nothing and delivers nothing a second time.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly channels: NotificationChannel[];

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Optional() @Inject(NOTIFICATION_CHANNELS) channels?: NotificationChannel[],
  ) {
    this.channels = channels ?? [new UnconfiguredEmailChannel()];
  }

  /**
   * Call inside the transaction that recorded the facts, so an event is stored if and only if
   * the change it describes is. In-app notifications are rows; other channels are delivered
   * afterwards by `dispatch`.
   */
  async emit(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    events: NotificationEvent[],
  ): Promise<EmitResult> {
    const result: EmitResult = { created: 0, duplicates: 0 };
    if (events.length === 0) return result;

    const members = await tx.workspaceMember.findMany({
      where: { workspaceId },
      select: { userId: true },
    });
    const types = [...new Set(events.map((e) => e.type))];
    const prefs = await tx.notificationPreference.findMany({
      where: { workspaceId, type: { in: types }, userId: { in: members.map((m) => m.userId) } },
    });
    const prefOf = new Map(prefs.map((p) => [`${p.userId}:${p.type}`, p]));

    for (const event of events) {
      const rendered = renderNotification(event);
      const key = dedupeKey(event);
      for (const { userId } of members) {
        const pref = prefOf.get(`${userId}:${event.type}`);
        const inApp = wants(pref, 'in_app');
        const email = wants(pref, 'email');
        if (!inApp && !email) continue; // this member muted this type
        // createMany + skipDuplicates is INSERT ... ON CONFLICT DO NOTHING: the count says
        // whether this call created the row, with no error that would abort the transaction.
        const inserted = await tx.notification.createMany({
          data: [
            {
              workspaceId,
              userId,
              type: event.type,
              dedupeKey: key,
              title: rendered.title,
              body: rendered.body,
              data: rendered.data as Prisma.InputJsonValue,
              deliveredChannels: inApp ? ['in_app'] : [],
            },
          ],
          skipDuplicates: true,
        });
        if (inserted.count === 1) result.created += 1;
        else result.duplicates += 1;
      }
    }
    return result;
  }

  /**
   * Delivers notifications through the configured non-in-app channels (email, later others) to
   * members who asked for them. Each notification is delivered once per channel: the channel is
   * recorded on the row, and only rows lacking it are picked up.
   */
  async dispatch(limit = 100): Promise<number> {
    let delivered = 0;
    for (const channel of this.channels.filter((c) => c.configured)) {
      const pending = await this.prisma.notification.findMany({
        where: { NOT: { deliveredChannels: { has: channel.id } } },
        orderBy: { id: 'asc' },
        take: limit,
        include: { user: { select: { email: true } } },
      });
      for (const n of pending) {
        const pref = await this.prisma.notificationPreference.findUnique({
          where: {
            workspaceId_userId_type: { workspaceId: n.workspaceId, userId: n.userId, type: n.type },
          },
        });
        if (!wants(pref ?? undefined, channel.id)) continue;
        // Claim first, then send: of two workers racing for the same notification, exactly one
        // wins the guarded update and sends. A failed send releases the claim for a later retry.
        const claimed = await this.prisma.notification.updateMany({
          where: { id: n.id, NOT: { deliveredChannels: { has: channel.id } } },
          data: { deliveredChannels: { push: channel.id } },
        });
        if (claimed.count !== 1) continue;
        try {
          await channel.deliver(
            {
              id: n.id,
              workspaceId: n.workspaceId,
              type: n.type,
              title: n.title,
              body: n.body,
              data: n.data as never,
            },
            { userId: n.userId, email: n.user.email },
          );
          delivered += 1;
        } catch (error) {
          this.logger.warn(`${channel.id} delivery of ${n.id} failed: ${(error as Error).message}`);
          const row = await this.prisma.notification.findUnique({
            where: { id: n.id },
            select: { deliveredChannels: true },
          });
          if (row) {
            await this.prisma.notification.update({
              where: { id: n.id },
              data: { deliveredChannels: row.deliveredChannels.filter((c) => c !== channel.id) },
            });
          }
        }
      }
    }
    return delivered;
  }
}
