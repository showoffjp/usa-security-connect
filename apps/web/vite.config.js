import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    // Do not rewrite paths to their realpath target. On Windows the app-data
    // folder can sit behind a redirect, and resolving through it makes the
    // resolved id stop matching the served URL, so the dev server falls back
    // to shipping raw JSX to the browser.
    preserveSymlinks: true,
    alias: {
      '@shared': path.resolve(here, '../../packages/shared/src'),
      '@': path.resolve(here, 'src'),
    },
  },
  server: {
    port: 5173,
    // packages/shared lives outside this app, so the dev server has to be
    // allowed to read from the monorepo root.
    fs: { allow: [path.resolve(here, '../..')] },
    // The API is a separate process; proxying keeps the browser on one origin.
    proxy: {
      '/api': { target: process.env.USC_API_URL || 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
