import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  companyMonitoringSchema,
  markAllReadResponseSchema,
  monitoringListQuerySchema,
  monitoringListResponseSchema,
  monitoringScheduleSchema,
  notificationListQuerySchema,
  notificationListResponseSchema,
  notificationPreferencesResponseSchema,
  notificationSchema,
  setCompanyMonitoringRequestSchema,
  updateNotificationPreferencesRequestSchema,
  updateScheduleRequestSchema,
  type CompanyMonitoring,
  type MonitoringListResponse,
  type MonitoringSchedule,
  type Notification,
  type NotificationListResponse,
  type NotificationPreferencesResponse,
  type SetCompanyMonitoringRequest,
  type UpdateNotificationPreferencesRequest,
  type UpdateScheduleRequest,
} from '@jobfinder/contracts';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth } from '../auth/decorators';
import { openApiSchema } from '../common/openapi';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentWorkspace, RequireRole, WorkspaceScoped } from '../workspaces/workspace.decorators';
import type { WorkspaceContext } from '../workspaces/workspace.types';
import { MonitoringService } from './monitoring.service';
import { NotificationsService } from './notifications.service';

@ApiTags('monitoring')
@ApiCookieAuth()
@WorkspaceScoped()
@Controller({ version: '1' })
export class MonitoringController {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- schedules

  @Get('monitoring')
  @ApiOkResponse({
    schema: openApiSchema(monitoringListResponseSchema),
    description: 'Monitoring schedules, newest first',
  })
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query(new ZodValidationPipe(monitoringListQuerySchema))
    query: z.infer<typeof monitoringListQuerySchema>,
  ): Promise<MonitoringListResponse> {
    return this.monitoring.list(workspace, query);
  }

  @Patch('monitoring/:id')
  @RequireRole('MEMBER')
  @ApiBody({ schema: openApiSchema(updateScheduleRequestSchema, 'input') })
  @ApiOkResponse({
    schema: openApiSchema(monitoringScheduleSchema),
    description: 'Enable/disable a schedule or change its interval',
  })
  @ApiNotFoundResponse()
  update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateScheduleRequestSchema)) body: UpdateScheduleRequest,
  ): Promise<MonitoringSchedule> {
    return this.monitoring.update(workspace, id, body);
  }

  @Post('monitoring/:id/run')
  @RequireRole('MEMBER')
  @HttpCode(202)
  @ApiAcceptedResponse({
    schema: openApiSchema(monitoringScheduleSchema),
    description: 'The check is due now; the scheduler runs it within a minute',
  })
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'The schedule is disabled' })
  run(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MonitoringSchedule> {
    return this.monitoring.runNow(workspace, id);
  }

  @Get('companies/:id/monitoring')
  @ApiOkResponse({ schema: openApiSchema(companyMonitoringSchema) })
  @ApiNotFoundResponse()
  forCompany(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CompanyMonitoring> {
    return this.monitoring.forCompany(workspace, id);
  }

  @Put('companies/:id/monitoring')
  @RequireRole('MEMBER')
  @ApiBody({ schema: openApiSchema(setCompanyMonitoringRequestSchema, 'input') })
  @ApiOkResponse({
    schema: openApiSchema(companyMonitoringSchema),
    description: 'Turns every schedule of the company on or off',
  })
  @ApiNotFoundResponse()
  setForCompany(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(setCompanyMonitoringRequestSchema))
    body: SetCompanyMonitoringRequest,
  ): Promise<CompanyMonitoring> {
    return this.monitoring.setCompany(workspace, id, body.enabled);
  }

  // ---------------------------------------------------------------- notifications

  @Get('notifications')
  @ApiOkResponse({
    schema: openApiSchema(notificationListResponseSchema),
    description: 'Your notifications in this workspace, newest first',
  })
  notificationList(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(notificationListQuerySchema))
    query: z.infer<typeof notificationListQuerySchema>,
  ): Promise<NotificationListResponse> {
    return this.notifications.list(workspace, auth.user.id, query);
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  @ApiOkResponse({ schema: openApiSchema(markAllReadResponseSchema) })
  readAll(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
  ): Promise<{ updated: number }> {
    return this.notifications.markAllRead(workspace, auth.user.id);
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  @ApiOkResponse({ schema: openApiSchema(notificationSchema) })
  @ApiNotFoundResponse()
  read(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Notification> {
    return this.notifications.markRead(workspace, auth.user.id, id);
  }

  @Get('notification-preferences')
  @ApiOkResponse({ schema: openApiSchema(notificationPreferencesResponseSchema) })
  preferences(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
  ): Promise<NotificationPreferencesResponse> {
    return this.notifications.preferences(workspace, auth.user.id);
  }

  @Put('notification-preferences')
  @ApiBody({ schema: openApiSchema(updateNotificationPreferencesRequestSchema, 'input') })
  @ApiOkResponse({
    schema: openApiSchema(notificationPreferencesResponseSchema),
    description: 'Omitted channels keep their value',
  })
  updatePreferences(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateNotificationPreferencesRequestSchema))
    body: UpdateNotificationPreferencesRequest,
  ): Promise<NotificationPreferencesResponse> {
    return this.notifications.updatePreferences(workspace, auth.user.id, body);
  }
}
