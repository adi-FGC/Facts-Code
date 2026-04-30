/**
 * Vite config — two build modes.
 *
 * - `pnpm dev`           → standard dev server on :3000, proxies /api/*
 *                          and /data/* to the CLI's `factstack ui` server
 *                          (:4848) so a live re-analyze round-trip works
 *                          even when the React app is running in dev mode.
 * - `pnpm build:static`  → emits a pure client-side SPA (`dist/`) suitable
 *                          for `factstack export` and VS Code webview hosts.
 *                          No server loaders; data comes from the inline
 *                          `<script id="factstack-data">` block.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react() as never],
  define: {
    // Let components branch on the build target without string literals.
    __FACTS_STATIC__: JSON.stringify(mode === 'static'),
  },
  server: {
    port: 3000,
    proxy: {
      '/api':  { target: 'http://127.0.0.1:4848', changeOrigin: true },
      '/data': { target: 'http://127.0.0.1:4848', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: mode !== 'static',
    // Inline small chunks so the static SPA is a single HTML + one JS.
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {},
    },
  },
}));
