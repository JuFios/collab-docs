import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { PlanLimitsService } from './plan-limits.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [NotificationsModule],
  controllers: [WorkspacesController, MembersController, InvitesController],
  providers: [WorkspacesService, MembersService, InvitesService, PlanLimitsService],
  exports: [PlanLimitsService],
})
export class WorkspacesModule {}
