import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The product tour at /tour/ (public/tour/index.html) shows the same pictures
 * as the README, which live in docs/screenshots. The dev server serves them
 * from there, and a build copies them in, so they are never kept twice.
 */
function tourImages() {
  const src = path.resolve(here, '../../docs/screenshots');
  let command = 'serve';
  return {
    name: 'usc-tour-images',
    configResolved(config) {
      command = config.command;
    },
    configureServer(server) {
      server.middlewares.use('/tour/img', (req, res, next) => {
        const file = path.join(src, decodeURIComponent((req.url || '').split('?')[0]));
        if (!file.startsWith(src + path.sep) || !fs.existsSync(file)) return next();
        res.setHeader('Content-Type', 'image/jpeg');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (command !== 'build') return;
      const out = path.resolve(here, 'dist/tour/img');
      fs.mkdirSync(out, { recursive: true });
      for (const f of fs.readdirSync(src)) if (f.endsWith('.jpg')) fs.copyFileSync(path.join(src, f), path.join(out, f));
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [react(), tourImages()],
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
