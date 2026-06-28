/**
 * Vite config — FactStack Chrome MV3 side-panel.
 *
 * Differences from apps/ui-remix that MV3 forces (see
 * docs/chrome-ext-sidepanel-plan.html §04):
 *   - `base: './'` so built assets are referenced relatively
 *     (chrome-extension://<id>/assets/… resolves; absolute /assets/… 404s).
 *   - Two entries: `panel.html` (the side-panel page) and `src/sw.ts`
 *     (the background service worker). The SW is emitted at a STABLE name
 *     (`sw.js`) so manifest.json can reference it across rebuilds.
 *   - No inline scripts in the HTML (MV3 bans them even when hashed) — the
 *     no-flash theme boot lives in `public/theme-init.js`, loaded via
 *     <script src>.
 *
 * JSX is esbuild's automatic runtime pointed at `remix/ui` — same React-free
 * VDOM as the dashboard. No `@vitejs/plugin-react`.
 */
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'remix/ui',
  },
  worker: {
    // The analyze worker is a module worker; keep it ES so Vite emits one
    // chunk per imported module (analyzer/extractors/scanners) rather than
    // an IIFE megabundle.
    format: 'es',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // MV3 ships no source maps.
    sourcemap: false,
    rollupOptions: {
      input: {
        panel: 'panel.html',
        sw: 'src/sw.ts',
      },
      output: {
        // Stable filename for the service worker so manifest.json can point
        // at it; everything else stays content-hashed + cacheable.
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
