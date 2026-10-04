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
 * JSX is handled by esbuild with the `remix/component` jsx-runtime — no
 * React, no `@vitejs/plugin-react`. The `mix` prop, theme tokens, and
 * `Frame` component come from the Remix runtime.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * `vite preview` sends each path the headers Cloudflare would: dist/_headers
 * read through the same model the build guards use (scripts/lib/cf-headers.mjs).
 * The e2e suite runs on preview, so the app is exercised under its production
 * CSP and a blocked inline script or style fails the run as a console error.
 * HSTS is left out on localhost.
 */
function previewProductionHeaders(): Plugin {
  return {
    name: 'factstack:preview-production-headers',
    async configurePreviewServer(server) {
      let text: string;
      try {
        text = readFileSync(
          resolve(server.config.root, server.config.build.outDir, '_headers'),
          'utf8',
        );
      } catch {
        return; // no build yet: plain preview
      }
      const model = pathToFileURL(resolve(server.config.root, 'scripts/lib/cf-headers.mjs')).href;
      const { parseHeadersFile, effectiveHeaders } = await import(model);
      const rules = parseHeadersFile(text);
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://preview').pathname;
        for (const [name, values] of effectiveHeaders(rules, path) as Map<string, string[]>) {
          if (name !== 'strict-transport-security') res.setHeader(name, values);
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [previewProductionHeaders()],
  esbuild: {
    // Tells esbuild to compile JSX with the automatic runtime sourced
    // from `remix/component` — the umbrella subpath for the component
    // runtime since Remix 3.0.0 (it was `remix/ui` in the betas).
    // Same flag-set React uses for its automatic runtime, pointed at
    // a different VDOM.
    jsx: 'automatic',
    jsxImportSource: 'remix/component',
  },
  define: {
    // Build-time toggle without string-literal branching in components.
    __FACTS_STATIC__: JSON.stringify(mode === 'static'),
  },
  server: {
    port: 3000,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4848', changeOrigin: true },
      // Everything under /data EXCEPT /data/docs/*: those per-doc bodies are
      // static files the build writes into dist (the CLI never serves them —
      // it inlines bodies), so `vite preview` must serve them from disk.
      '^/data/(?!docs/)': { target: 'http://127.0.0.1:4848', changeOrigin: true },
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
