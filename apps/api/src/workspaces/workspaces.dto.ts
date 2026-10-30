import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsIn, IsString, Length, MaxLength } from 'class-validator';
import { PLAN_TIERS, WORKSPACE_ROLES, type WorkspaceRole } from '@collab-docs/shared';
import { NotReleasedEmail } from '../auth/not-released-email';

const INVITABLE_ROLES = WORKSPACE_ROLES.filter((role) => role !== 'OWNER');

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const normaliseEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateWorkspaceDto {
  @ApiProperty({ example: 'Acme', maxLength: 80 })
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  name!: string;
}

export class UpdateWorkspaceDto {
  @ApiProperty({ example: 'Acme', maxLength: 80 })
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  name!: string;
}

export class UpdateMemberDto {
  @ApiProperty({ enum: WORKSPACE_ROLES })
  @IsEnum(WORKSPACE_ROLES)
  role!: WorkspaceRole;
}

export class CreateInviteDto {
  @ApiProperty({ example: 'grace@example.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  @NotReleasedEmail()
  email!: string;

  @ApiProperty({ enum: INVITABLE_ROLES })
  @IsIn(INVITABLE_ROLES)
  role!: WorkspaceRole;
}

export class WorkspaceResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: WORKSPACE_ROLES, description: "The caller's role" })
  role!: string;
  @ApiProperty({ enum: PLAN_TIERS }) plan!: string;
  @ApiProperty() createdAt!: string;
}

export class MemberResponse {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: WORKSPACE_ROLES }) role!: string;
  @ApiProperty() joinedAt!: string;
}

export class InviteResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: WORKSPACE_ROLES }) role!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ format: 'uuid' }) invitedBy!: string;
}

export class InvitePreviewResponse {
  @ApiProperty() workspaceName!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: WORKSPACE_ROLES }) role!: string;
  @ApiProperty() inviterName!: string;
  @ApiProperty() expiresAt!: string;
}

export class AcceptInviteResponse {
  @ApiProperty({ format: 'uuid' }) workspaceId!: string;
  @ApiProperty({ enum: WORKSPACE_ROLES }) role!: string;
}

class UsageMembers {
  @ApiProperty() current!: number;
  @ApiProperty() pendingInvites!: number;
  @ApiProperty() limit!: number;
}
class UsageDocuments {
  @ApiProperty() current!: number;
  @ApiPropertyOptional({ nullable: true, type: Number, description: 'null = unlimited' })
  limit!: number | null;
}
class UsageStorage {
  @ApiProperty() currentBytes!: number;
  @ApiProperty() limitBytes!: number;
}

export class UsageResponse {
  @ApiProperty({ enum: PLAN_TIERS }) plan!: string;
  @ApiProperty({ type: UsageMembers }) members!: UsageMembers;
  @ApiProperty({ type: UsageDocuments }) documents!: UsageDocuments;
  @ApiProperty({ type: UsageStorage }) storage!: UsageStorage;
}
