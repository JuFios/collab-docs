import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, MaxLength, MinLength } from 'class-validator';
// argon2 accepts long inputs, but unbounded ones are a cheap way to burn CPU: the maximum is the same on every layer
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@collab-docs/shared';

const normaliseEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RegisterDto {
  @ApiProperty({ example: 'ada@example.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiProperty({ example: 'Ada Lovelace', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  name!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'ada@example.com' })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}

export class AuthUserResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
}

export class AuthSessionResponse {
  @ApiProperty({ type: AuthUserResponse }) user!: AuthUserResponse;
  @ApiProperty({
    description: 'Access JWT, also set as the httpOnly cookie cd_at. Usable as a Bearer token.',
  })
  accessToken!: string;
  @ApiProperty({ description: 'Access token lifetime in seconds.' }) expiresIn!: number;
}
