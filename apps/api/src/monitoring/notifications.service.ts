import { Injectable, NotFoundException } from '@nestjs/common';
import type { Notification as NotificationRow, Prisma } from '@jobfinder/database';
import {
  notificationTypeSchema,
  type Notification,
  type NotificationListQuery,
  type NotificationListResponse,
  type NotificationPreferencesResponse,
  type UpdateNotificationPreferencesRequest,
} from '@jobfinder/contracts';
import { DEFAULT_CHANNEL_PREFERENCE } from '@jobfinder/monitoring';
import { PrismaService } from '../prisma/prisma.service';
import type { WorkspaceContext } from '../workspaces/workspace.types';

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    data:
      row.data && typeof row.data === 'object' && !Array.isArray(row.data)
        ? (row.data as Record<string, unknown>)
        : {},
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}

/**
 * Notifications belong to one member of one workspace: every query filters by both, so nobody
 * can read, or mark as read, anyone else's.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The in-app feed only: a member who chose email-only never sees the item in the app. */
  private scope(workspace: WorkspaceContext, userId: string): Prisma.NotificationWhereInput {
    return { workspaceId: workspace.id, userId, deliveredChannels: { has: 'in_app' } };
  }

  async list(
    workspace: WorkspaceContext,
    userId: string,
    query: NotificationListQuery,
  ): Promise<NotificationListResponse> {
    const scope = this.scope(workspace, userId);
    const [rows, unreadCount] = await Promise.all([
      this.prisma.client.notification.findMany({
        where: {
          ...scope,
          ...(query.unread === true
            ? { readAt: null }
            : query.unread === false
              ? { readAt: { not: null } }
              : {}),
          ...(query.type ? { type: query.type } : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      }),
      this.prisma.client.notification.count({ where: { ...scope, readAt: null } }),
    ]);
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toNotification),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
      unreadCount,
    };
  }

  async markRead(workspace: WorkspaceContext, userId: string, id: string): Promise<Notification> {
    const row = await this.prisma.client.notification.findFirst({
      where: { id, ...this.scope(workspace, userId) },
    });
    if (!row) throw new NotFoundException('Notification not found');
    if (row.readAt) return toNotification(row);
    return toNotification(
      await this.prisma.client.notification.update({ where: { id }, data: { readAt: new Date() } }),
    );
  }

  async markAllRead(workspace: WorkspaceContext, userId: string): Promise<{ updated: number }> {
    const result = await this.prisma.client.notification.updateMany({
      where: { ...this.scope(workspace, userId), readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  async preferences(
    workspace: WorkspaceContext,
    userId: string,
  ): Promise<NotificationPreferencesResponse> {
    const rows = await this.prisma.client.notificationPreference.findMany({
      where: { workspaceId: workspace.id, userId },
    });
    const byType = new Map(rows.map((r) => [r.type, r]));
    return {
      // Every type is listed; one without a stored choice shows the defaults.
      items: notificationTypeSchema.options.map((type) => ({
        type,
        inApp: byType.get(type)?.inApp ?? DEFAULT_CHANNEL_PREFERENCE.in_app,
        email: byType.get(type)?.email ?? DEFAULT_CHANNEL_PREFERENCE.email,
      })),
    };
  }

  async updatePreferences(
    workspace: WorkspaceContext,
    userId: string,
    input: UpdateNotificationPreferencesRequest,
  ): Promise<NotificationPreferencesResponse> {
    const current = new Map(
      (await this.preferences(workspace, userId)).items.map((i) => [i.type, i]),
    );
    for (const change of input.preferences) {
      const base = current.get(change.type)!;
      const next = { inApp: change.inApp ?? base.inApp, email: change.email ?? base.email };
      await this.prisma.client.notificationPreference.upsert({
        where: {
          workspaceId_userId_type: { workspaceId: workspace.id, userId, type: change.type },
        },
        create: { workspaceId: workspace.id, userId, type: change.type, ...next },
        update: next,
      });
    }
    return this.preferences(workspace, userId);
  }
}
