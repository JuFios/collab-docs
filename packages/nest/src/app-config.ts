import { type DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { parseConfig } from './config';

/**
 * Global `ConfigModule` that validates the environment with the zod schema in `config.ts`. Inject it as
 * `ConfigService<AppConfig, true>` and read values with `get('NAME', { infer: true })`. The process
 * environment is the only source: files are loaded by the runtime (`node --env-file`, Docker Compose).
 */
export function appConfigModule(): Promise<DynamicModule> {
  // `ConfigModule.forRoot` is async and would turn an invalid environment into a rejected promise;
  // validating here keeps the failure synchronous, at import time, as it has always been
  parseConfig(process.env);
  return ConfigModule.forRoot({
    isGlobal: true,
    ignoreEnvFile: true,
    validate: (env) => parseConfig(env),
  });
}
