import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The web app. Served by the Worker's static assets under /app/, so it is built into
 * dist/web/app with base /app/. `pnpm dev:web` proxies /api to `wrangler dev` on :8787.
 */
export default defineConfig({
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  base: '/app/',
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL('./dist/web/app', import.meta.url)), emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
