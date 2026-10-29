import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { PlanLimitsModule } from './plan-limits.module';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { PermissionsModule } from '../permissions/permissions.module';

@Module({
  imports: [MailModule, PermissionsModule, PlanLimitsModule],
  controllers: [WorkspacesController, MembersController, InvitesController],
  providers: [WorkspacesService, MembersService, InvitesService],
})
export class WorkspacesModule {}
