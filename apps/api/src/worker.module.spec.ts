import type { DynamicModule, Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { WorkerPlatformModule } from '@collab-docs/nest';
import { WorkerModule } from './worker.module';

type Imported = Type | DynamicModule | Promise<DynamicModule>;

/**
 * Every feature module the root imports, directly or through others, with the controllers each declares. The
 * platform is left out: its metrics controller is shared infrastructure whose guard needs only the configuration.
 */
function controllersOf(root: Type): Map<string, unknown[]> {
  const found = new Map<string, unknown[]>();
  const visit = (entry: Imported) => {
    if (entry instanceof Promise) return;
    const module = 'module' in entry ? entry.module : entry;
    if (module === WorkerPlatformModule || found.has(module.name)) return;
    const own =
      (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, module) as unknown[] | undefined) ?? [];
    const dynamic = 'module' in entry ? (entry.controllers ?? []) : [];
    found.set(module.name, [...own, ...dynamic]);
    const imports = [
      ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) as Imported[] | undefined) ?? []),
      ...('module' in entry ? ((entry.imports as Imported[] | undefined) ?? []) : []),
    ];
    imports.forEach(visit);
  };
  visit(root);
  return found;
}

// The suites run the worker's modules inside the api application, which provides what HTTP needs (rate limiting
// among it). The worker process serves no HTTP and has none of that: a controller pulled in through a feature
// module would fail only there, at start-up, when Nest builds the guards of its routes.
describe('worker process', () => {
  it('loads no module that declares controllers', () => {
    const withControllers = [...controllersOf(WorkerModule)].filter(([, list]) => list.length > 0);
    expect(withControllers.map(([name]) => name)).toEqual([]);
  });
});
