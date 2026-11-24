import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SessionCookieService } from './session-cookie.service';
import { SessionService } from './session.service';

@Module({
  imports: [WorkspacesModule],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, SessionService, SessionCookieService],
  exports: [SessionService, SessionCookieService],
})
export class AuthModule {}
