import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { AllExceptionsFilter } from './exceptions';
import { createValidationPipe } from './validation';

/** Global request validation and the centralized error filter, registered as providers instead of `useGlobal*`. */
@Module({
  providers: [
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class RequestPipelineModule {}
