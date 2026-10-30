import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  base: '/',
  build: {
    target: 'es2022',
    outDir: fileURLToPath(new URL('../../dist/original-web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    proxy: {
      '/original-ws': {
        target: 'http://127.0.0.1:7777',
        ws: true,
      },
    },
  },
});
