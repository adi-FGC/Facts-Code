/**
 * Vite config — Remix v3 UI runtime, React-free.
 *
 * - `pnpm dev`           → dev server on :3000, proxies /api/* and /data/*
 *                          to the CLI's `factstack ui` server (:4848) so a
 *                          live re-analyze round-trip works in dev.
 * - `pnpm build`         → emits a pure client-side SPA (`dist/`) suitable
 *                          for the Netlify deploy + `factstack export` +
 *                          future VS Code webview hosts. Data comes from
 *                          the inline `<script id="factstack-data">` block
 *                          baked by `scripts/inject-data.mjs`.
 *
 * JSX is handled by esbuild with the `@remix-run/ui` jsx-runtime — no
 * React, no `@vitejs/plugin-react`. The `mix` prop, theme tokens, and
 * `Frame` component come from the Remix runtime.
 */
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  esbuild: {
    // Tells esbuild to compile JSX with the automatic runtime sourced
    // from `remix/ui` — the canonical umbrella subpath. In beta.0/.1/.2
    // this re-exports the standalone `@remix-run/ui` package, but the
    // upstream trajectory folds the source into the umbrella's
    // packages/ui/, after which the standalone goes away. Importing
    // through `remix/ui` survives that migration.
    // Same flag-set React uses for its automatic runtime, pointed at
    // a different VDOM.
    jsx: 'automatic',
    jsxImportSource: 'remix/ui',
  },
  define: {
    // Build-time toggle without string-literal branching in components.
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
    // Inline small chunks so the static SPA stays close to a single
    // HTML + one JS bundle.
    assetsInlineLimit: 4096,
  },
}));
