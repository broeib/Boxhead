import { build } from 'esbuild';

await build({
  entryPoints: ['apps/original-server/index.mjs'],
  outfile: 'dist/original-server/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: 'import { createRequire as __originalCreateRequire } from "node:module"; const require = __originalCreateRequire(import.meta.url);' },
  legalComments: 'eof',
  logLevel: 'info',
});
