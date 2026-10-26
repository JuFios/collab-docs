import { Body, Controller, Get, Param, Post, Query, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { IsString, Length } from 'class-validator';
import {
  AppException,
  PaginationQueryDto,
  ParseUuidPipe,
  RateLimit,
  getCorrelationId,
} from '@collab-docs/nest';
import { AppModule } from '../app.module';
import { Public } from '../auth/auth.decorators';
import { configureApp } from '../bootstrap';

class CreateThingDto {
  @IsString()
  @Length(1, 10)
  name!: string;
}

@Public()
@Controller('test')
export class TestController {
  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }

  @Get('items/:id')
  item(@Param('id', ParseUuidPipe) id: string): { id: string } {
    return { id };
  }

  @Get('page')
  page(@Query() query: PaginationQueryDto): PaginationQueryDto {
    return query;
  }

  @Post('things')
  create(@Body() body: CreateThingDto): CreateThingDto {
    return body;
  }

  @Get('login-limited')
  @RateLimit.login()
  limited(): { ok: true } {
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    throw new Error('connection to db-internal.example failed: password=hunter2');
  }

  @Get('forbidden')
  forbidden(): never {
    throw new AppException('FORBIDDEN', 'Not allowed here');
  }

  @Get('correlation')
  correlation(): { correlationId: string | undefined } {
    return { correlationId: getCorrelationId() };
  }
}

export async function createTestApp(
  extra: Type[] = [TestController],
  imports: Type[] = [],
): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ...imports],
    controllers: extra,
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app);
  await app.init();
  return app;
}
