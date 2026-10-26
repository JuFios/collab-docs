import { DynamicModule, Global, Module } from '@nestjs/common';
import { type AppConfig, parseConfig } from './config';

export const APP_CONFIG = Symbol('APP_CONFIG');

let current: AppConfig | undefined;

/** Config of the running process; decorators that need values at import time (rate-limit presets) read it lazily. */
export function currentConfig(): AppConfig {
  current ??= parseConfig(process.env);
  return current;
}

export function setCurrentConfig(config: AppConfig): void {
  current = config;
}

@Global()
@Module({})
export class AppConfigModule {
  /** Validates `process.env` (or uses the given config) and exposes it under `APP_CONFIG`. */
  static forRoot(config?: AppConfig): DynamicModule {
    const resolved = config ?? parseConfig(process.env);
    setCurrentConfig(resolved);
    return {
      module: AppConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: resolved }],
      exports: [APP_CONFIG],
    };
  }
}
