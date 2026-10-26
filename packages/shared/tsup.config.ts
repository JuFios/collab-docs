import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'content/index': 'src/content/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
  // keep dependencies external so each consumer's resolver (Node, Jest, Vitest, Next) loads them
  external: ['jose'],
  // ESM-only and tiny: inlined so CommonJS consumers (Nest, Jest) need no ESM handling
  noExternal: ['fractional-indexing'],
});
