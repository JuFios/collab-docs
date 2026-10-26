import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Global module for the Prisma client provider. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
