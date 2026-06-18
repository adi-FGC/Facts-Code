/**
 * @factstack/extractors — route extractor.
 *
 * Detects HTTP/page routes from the three most-common framework flavors
 * in a polyglot monorepo:
 *
 *  - Next.js App Router     app/xxx/route.ts       → method-per-export
 *  - Next.js App Router     app/xxx/page.tsx       → GET page
 *  - Next.js Pages Router   pages/xxx.tsx          → page route
 *  - Remix / React Router   app/routes/xxx.tsx     → page route
 *  - Express-style          app.get('/path', ...)  / router.post / fastify / koa
 *  - FastAPI                @app.get("/path")
 *  - Flask                  @app.route("/path", methods=["..."])
 *  - Django URLs            path("foo/", view) / re_path(r"...", view)
 *
 * Pure-JS (no AST for the framework-specific side — lightweight regex
 * over source; the decorated-line patterns are unambiguous enough for a
 * high-precision first pass). File-path-based patterns for Next/Remix
 * don't need source at all.
 */

export interface DetectedRoute {
  framework: 'nextjs' | 'remix' | 'astro' | 'express' | 'fastapi' | 'flask' | 'django' | 'node-http' | 'react-router' | 'spa-page';
  /** HTTP method, or null for page/screen entries that respond to GET implicitly. */
  method: string | null;
  /** Declared URL path (may include route params: `/users/:id`, `/users/{id}`). */
  path: string;
  /** File containing the declaration (project-relative). */
  handlerFile: string;
  /** Named export or function symbol that handles the request, if we can find one. */
  handlerSymbol: string | null;
}

/** Probe file paths (no source read needed) — call for every walked file.
 *  Skips test + fixture paths so a project's test suite doesn't pollute
 *  the routes artifact. */
export function detectFileBasedRoutes(filePath: string): DetectedRoute[] {
  if (isTestOrFixturePath(filePath)) return [];
  const out: DetectedRoute[] = [];
  const name = basename(filePath);
  const ext = extOf(filePath);

  // Next.js App Router: app/**/route.{ts,js}
  const appRoute = /(?:^|\/)app\/(.*?)\/(?:route)\.(ts|tsx|js|jsx|mjs)$/.exec(filePath);
  if (appRoute && appRoute[1] != null) {
    // All methods in a route file are potential handlers; without reading
    // source we can't tell which. Emit a single entry that the source
    // extractor can refine.
    out.push({
      framework: 'nextjs',
      method: null,
      path: '/' + toNextRoute(appRoute[1]),
      handlerFile: filePath,
      handlerSymbol: null,
    });
    return out;
  }
  // Next.js App Router page: app/**/page.{ts,tsx}
  const appPage = /(?:^|\/)app\/(.*?)\/(?:page)\.(ts|tsx|js|jsx|mjs)$/.exec(filePath);
  if (appPage && appPage[1] != null) {
    out.push({
      framework: 'nextjs',
      method: 'GET',
      path: '/' + toNextRoute(appPage[1]),
      handlerFile: filePath,
      handlerSymbol: 'default',
    });
    return out;
  }
  // Next.js App Router root page: app/page.{ts,tsx}
  if (/(?:^|\/)app\/page\.(ts|tsx|js|jsx|mjs)$/.test(filePath)) {
    out.push({ framework: 'nextjs', method: 'GET', path: '/', handlerFile: filePath, handlerSymbol: 'default' });
    return out;
  }
  // Astro: src/pages/**/*.{astro,ts,js,md,mdx}. Checked BEFORE the
  // Next.js pages-router because both share the `pages/` segment;
  // running pages-router first would steal `src/pages/foo.tsx` away
  // from the Astro path which has a more specific (and thus more
  // accurate) handler.
  //   src/pages/about.astro     → /about (GET)
  //   src/pages/blog/[slug].md  → /blog/:slug (GET)
  //   src/pages/api/foo.ts      → /api/foo (method refined by source extractor)
  const astroMatch = /(?:^|\/)src\/pages\/(.+)\.(astro|ts|tsx|js|jsx|mjs|md|mdx)$/.exec(filePath);
  if (astroMatch && astroMatch[1]) {
    const astroPath = astroMatch[1];
    const isApi = /^api(\/|$)/.test(astroPath);
    const route = astroPath.replace(/(^|\/)index$/, '') || '';
    out.push({
      framework: 'astro',
      // API routes typically declare per-method handlers via `export
      // const POST/GET/...`. The source-based pass refines this; the
      // file-based pass emits a method-agnostic stub (null) for API
      // routes and explicit GET for pages.
      method: isApi ? null : 'GET',
      path: '/' + toAstroRoute(route),
      handlerFile: filePath,
      handlerSymbol: isApi ? null : 'default',
    });
    return out;
  }
  // Next.js Pages Router: pages/**/*.{ts,tsx,js}
  // Checked AFTER Astro because both share the `pages/` segment —
  // checking Astro first means `src/pages/foo.tsx` lands in Astro
  // (more specific path → more accurate framework label).
  const pagesMatch = /(?:^|\/)pages\/(.+)\.(ts|tsx|js|jsx|mjs)$/.exec(filePath);
  if (pagesMatch && pagesMatch[1] && !pagesMatch[1].startsWith('_')) {
    // Strip trailing "index" regardless of whether it's at the root
    // (`pages/index.tsx` → "") or nested (`pages/blog/index.tsx` → "blog").
    const route = pagesMatch[1].replace(/(^|\/)index$/, '') || '';
    out.push({
      framework: 'nextjs',
      method: 'GET',
      path: '/' + toNextRoute(route),
      handlerFile: filePath,
      handlerSymbol: 'default',
    });
    return out;
  }
  // Remix v2:           app/routes/**.{ts,tsx}
  // React Router v7:    src/routes/**.{ts,tsx}  (Vite-conventional layout)
  // Both use the same flat-routes naming inside the routes folder.
  const remixMatch = /(?:^|\/)(?:app|src)\/routes\/(.+)\.(ts|tsx|jsx|js)$/.exec(filePath);
  if (remixMatch && remixMatch[1]) {
    out.push({
      framework: 'remix',
      method: 'GET',
      path: '/' + toRemixRoute(remixMatch[1]),
      handlerFile: filePath,
      handlerSymbol: 'default',
    });
    return out;
  }

  return out;
}

/**
 * Source-based extractor. Called per JS/TS/Python file — pattern-matches
 * against common framework signatures. Does NOT replace AST parsing for
 * deep type info; it's a high-precision pass suited to the kinds of
 * route declarations that sit at module scope.
 *
 * Skips test/spec files and example fixtures so a project's test suite
 * doesn't pollute the routes artifact with phantom endpoints. The
 * dashboard previously showed `/api/hello` from `routes.test.ts` as a
 * real route — confusing CXOs and AI agents alike.
 */
export function detectSourceRoutes(filePath: string, source: string): DetectedRoute[] {
  if (isTestOrFixturePath(filePath)) return [];
  const ext = extOf(filePath);
  if (ext === '.py') return detectPythonRoutes(filePath, source);
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(ext)) return detectJsRoutes(filePath, source);
  return [];
}

/** True for `*.test.*`, `*.spec.*`, `__tests__/`, `examples/`, `fixtures/`. */
function isTestOrFixturePath(p: string): boolean {
  const normalized = p.toLowerCase().replace(/\\/g, '/');
  if (/(?:^|\/)__tests__\//.test(normalized)) return true;
  if (/(?:^|\/)(?:test|tests|__test__|examples|fixtures)\//.test(normalized)) return true;
  if (/\.(test|spec)\.[a-z]+$/.test(normalized)) return true;
  return false;
}

function detectJsRoutes(filePath: string, source: string): DetectedRoute[] {
  const out: DetectedRoute[] = [];
  const seen = new Set<string>();

  // ── raw Node `http.createServer((req, res) => …)` handlers ────────────
  // Only fires when the file actually imports node:http and contains a
  // `createServer(` call — otherwise any `req.url === '/x'` check (e.g.
  // request matchers in middleware) would emit phantom routes.
  //
  // Pattern: `req.method === 'METHOD' && url.pathname === '/path'`
  //          (or `req.url === '/path'`, with or without the method check).
  // The factstack CLI's own server is the canonical example.
  const usesNodeHttp = /from\s+['"]node:http['"]|require\(\s*['"]node:http['"]\s*\)|from\s+['"]http['"]/.test(source) && /createServer\s*\(/.test(source);
  if (usesNodeHttp) {
    // Method+path together (most precise)
    const pairRe = /req\.method\s*===\s*['"]([A-Z]+)['"]\s*&&\s*(?:url\.pathname|req\.url)\s*===\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec(source))) {
      if (!m[1] || !m[2] || !m[2].startsWith('/')) continue;
      const key = m[1] + '|' + m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ framework: 'node-http', method: m[1], path: m[2], handlerFile: filePath, handlerSymbol: null });
    }
    // Path-only (when method check is implicit or absent)
    const pathOnlyRe = /(?:url\.pathname|req\.url)\s*===\s*['"]([^'"]+)['"]/g;
    while ((m = pathOnlyRe.exec(source))) {
      if (!m[1] || !m[1].startsWith('/')) continue;
      const key = 'GET|' + m[1];
      // Only add if no method-qualified version was already added for this path
      if ([...seen].some((k) => k.endsWith('|' + m![1]))) continue;
      seen.add(key);
      out.push({ framework: 'node-http', method: null, path: m[1], handlerFile: filePath, handlerSymbol: null });
    }
  }

  // app.get('/path', …) / router.post('/x', …) / fastify.put / koa
  // Match `<ident>.<method>('path', …)` where method ∈ http verbs.
  //
  // Gate: file must import an express-family package. Without this gate,
  // the extractor matches its own example strings inside comments (e.g.
  // `// app.get('/path', …)` in routes.ts itself becomes 3 phantom
  // routes — and any utility file that uses `Map.prototype.delete` or
  // `Set.prototype.has` shaped patterns generates false positives too.
  const usesExpressFamily = /from\s+['"](?:express|koa|fastify|hapi|hono|@hono\/[\w-]+|@fastify\/[\w-]+|polka|micro|h3|elysia)['"]|require\(\s*['"](?:express|koa|fastify|hapi|hono|polka)['"]\s*\)/.test(source);
  let m: RegExpExecArray | null;
  if (usesExpressFamily) {
    const expressRe = /\b([a-zA-Z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|head|options|all|use)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    while ((m = expressRe.exec(source))) {
      if (!m[2] || !m[3]) continue;
      const method = m[2].toUpperCase();
      const path = m[3];
      // Routes must start with '/' — guards against `myMap.delete(key)`,
      // `COLLAPSED.delete('__EXPAND__:' + id)`, etc. being misread as
      // DELETE /key.
      if (!path.startsWith('/')) continue;
      const key = method + '|' + path;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ framework: 'express', method, path, handlerFile: filePath, handlerSymbol: null });
    }
  }
  // Next.js route.ts exports named GET/POST/… — treat as refinements.
  if (/(?:^|\/)app\/.*\/route\.(ts|tsx|js|jsx|mjs)$/.test(filePath)) {
    // `async?` would mean "asyn with optional c"; the original intent was
    // "async keyword is optional" — match both `export async function GET`
    // and `export function GET`.
    const methodRe = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
    while ((m = methodRe.exec(source))) {
      if (!m[1]) continue;
      const verb = m[1];
      out.push({
        framework: 'nextjs',
        method: verb,
        path: '/' + toNextRoute(extractAppRoute(filePath)),
        handlerFile: filePath,
        handlerSymbol: verb,
      });
    }
  }
  // Astro API routes: `export const POST: APIRoute = ...` (or plain
  // `export const POST = …`). Refines the file-based stub which
  // emitted method=null.
  const astroApiMatch = /(?:^|\/)src\/pages\/(api\/.+)\.(ts|tsx|js|jsx|mjs)$/.exec(filePath);
  if (astroApiMatch && astroApiMatch[1]) {
    const apiBase = astroApiMatch[1];
    const methodRe = /export\s+(?:async\s+)?(?:const|function|let)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL)\b/g;
    while ((m = methodRe.exec(source))) {
      if (!m[1]) continue;
      const verb = m[1];
      const route = apiBase.replace(/(^|\/)index$/, '') || '';
      out.push({
        framework: 'astro',
        method: verb === 'ALL' ? null : verb,
        path: '/' + toAstroRoute(route),
        handlerFile: filePath,
        handlerSymbol: verb,
      });
    }
  }
  return out;
}

function detectPythonRoutes(filePath: string, source: string): DetectedRoute[] {
  const out: DetectedRoute[] = [];
  const lines = source.split('\n');

  // FastAPI: `@app.get("/path")` / `@router.post("/path", ...)`
  // Flask:   `@app.route("/path", methods=["GET", "POST"])`
  const fastRe = /@([a-zA-Z_][\w]*)\.(get|post|put|patch|delete|head|options)\s*\(\s*['"]([^'"]+)['"]/i;
  const flaskRe = /@([a-zA-Z_][\w]*)\.route\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?/i;
  // Django:  `path("foo/", view)` / `re_path(r"^foo/$", view)`
  const djangoRe = /\b(path|re_path)\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*([a-zA-Z_][\w.]*)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line == null) continue;
    let m = fastRe.exec(line);
    if (m && m[2] && m[3]) {
      out.push({ framework: 'fastapi', method: m[2].toUpperCase(), path: m[3], handlerFile: filePath, handlerSymbol: findFunctionAfter(lines, i) });
      continue;
    }
    m = flaskRe.exec(line);
    if (m && m[2]) {
      const path = m[2];
      const methods = m[3] ? m[3].split(',').map((s) => s.replace(/['"\s]/g, '').toUpperCase()).filter(Boolean) : ['GET'];
      for (const method of methods) {
        out.push({ framework: 'flask', method, path, handlerFile: filePath, handlerSymbol: findFunctionAfter(lines, i) });
      }
      continue;
    }
    m = djangoRe.exec(line);
    if (m && m[2] && m[3]) {
      out.push({ framework: 'django', method: 'GET', path: m[2].replace(/^\^/, '').replace(/\$$/, ''), handlerFile: filePath, handlerSymbol: m[3] });
    }
  }
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────

function findFunctionAfter(lines: string[], i: number): string | null {
  // Look at the next ~3 lines for a `def funcName(`.
  for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
    const ln = lines[j];
    if (ln == null) continue;
    const m = /^\s*(?:async\s+)?def\s+([a-zA-Z_][\w]*)\s*\(/.exec(ln);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * Normalize a PascalCase / camelCase segment into kebab-case for URL display.
 *
 *   "Attendance"        → "attendance"
 *   "DashboardStudent"  → "dashboard-student"
 *   "HTMLForm"          → "html-form"        (acronym + word)
 *   "iOSDevice"         → "i-o-s-device"      (technically wrong, but rare;
 *                                              we err on the side of splitting)
 *   "user"              → "user"             (already lowercase, untouched)
 *   "404"               → "404"              (no letters to split)
 *
 * Two boundary regexes handle the common shapes:
 *
 *   1. lowercase → uppercase    `userProfile` → `user-Profile`
 *   2. UPPER → Upper-lower      `HTMLForm`    → `HTML-Form`
 *
 * Both run before the final lowercase to avoid creating boundaries inside
 * already-formed kebab names. The function is idempotent: calling it twice
 * on the result returns the same string.
 */
function pascalToKebab(seg: string): string {
  if (!seg) return seg;
  // Case 1 first: handles `dashboardStudent` → `dashboard-Student`.
  // Case 2 second: handles `HTMLForm` → `HTML-Form`.
  return seg
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

function toNextRoute(fragment: string): string {
  // Next.js dynamic segments: [id] → :id, [...slug] → *, (group) → omitted
  // Static segments are kebab-cased from any PascalCase/camelCase input —
  // URL paths are conventionally lowercase + hyphenated, and React
  // Router/Vite SPAs that use the pages-router file convention typically
  // reference routes that way even when the component file is PascalCase
  // (e.g. DashboardStudent.jsx → /dashboard-student).
  return fragment
    .split('/')
    .filter((seg) => !(seg.startsWith('(') && seg.endsWith(')')))
    .map((seg) => {
      if (seg.startsWith('[...') && seg.endsWith(']')) return '*';
      const m = /^\[(.+)\]$/.exec(seg);
      if (m && m[1]) return ':' + m[1];
      return pascalToKebab(seg);
    })
    .join('/');
}

/** Astro pages router params: `[slug]` → `:slug`, `[...slug]` → `*`. */
function toAstroRoute(fragment: string): string {
  return fragment
    .split('/')
    .map((seg) => {
      if (seg.startsWith('[...') && seg.endsWith(']')) return '*';
      const m = /^\[(.+)\]$/.exec(seg);
      if (m && m[1]) return ':' + m[1];
      return pascalToKebab(seg);
    })
    .join('/');
}

function toRemixRoute(fragment: string): string {
  // Remix/React Router v7 flat routes: `users.$id` → `users/:id`
  // Splat: `files.$` → `files/*`. Index routes drop the index segment in
  // EVERY convention spelling: Remix v2 `_index` / `foo._index`, and the
  // Remix v1 / React Router spelling without the underscore — bare
  // `index`, dotted `foo.index`, and directory-style `foo/index`.
  // (`routes/index.jsx` declaring `/` used to emit `/index` — a route
  // that doesn't exist.)
  //
  // PascalCase → kebab-case: React Router v7 component files are often
  // PascalCase (Files.tsx, DashboardStudent.tsx). URLs are kebab-cased
  // by convention so a multi-word component name produces a multi-word
  // URL like `/dashboard-student`. Dynamic params (`:id`) and splats
  // (`*`) pass through untouched.
  const stripped = fragment.replace(/(^|[./])_?index$/i, '');
  return stripped
    .split('.')
    .map((seg) => {
      if (seg === '$') return '*';
      if (seg.startsWith('$')) return ':' + seg.slice(1);
      return pascalToKebab(seg);
    })
    .join('/');
}

function extractAppRoute(filePath: string): string {
  const m = /(?:^|\/)app\/(.*?)\/(?:route|page)\.(?:ts|tsx|js|jsx|mjs)$/.exec(filePath);
  return m && m[1] ? m[1] : '';
}

function extOf(p: string): string {
  const dot = p.lastIndexOf('.');
  const slash = p.lastIndexOf('/');
  return dot > slash ? p.slice(dot).toLowerCase() : '';
}

function basename(p: string): string {
  const slash = p.lastIndexOf('/');
  return slash < 0 ? p : p.slice(slash + 1);
}
