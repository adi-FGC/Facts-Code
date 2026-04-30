import { describe, expect, it } from 'vitest';
import { detectFileBasedRoutes, detectSourceRoutes } from '../src/routes.js';

describe('detectFileBasedRoutes', () => {
  it('maps Next.js app-router route.ts files', () => {
    const r = detectFileBasedRoutes('app/users/[id]/route.ts');
    expect(r[0]?.path).toBe('/users/:id');
    expect(r[0]?.framework).toBe('nextjs');
  });

  it('maps pages-router dynamic segments', () => {
    const r = detectFileBasedRoutes('pages/blog/[slug].tsx');
    expect(r[0]?.path).toBe('/blog/:slug');
  });

  it('maps Remix flat routes', () => {
    const r = detectFileBasedRoutes('app/routes/users.$id.edit.tsx');
    expect(r[0]?.path).toBe('/users/:id/edit');
    expect(r[0]?.framework).toBe('remix');
  });

  it('skips unrelated files', () => {
    expect(detectFileBasedRoutes('src/utils/format.ts')).toEqual([]);
  });

  it('kebab-cases compound PascalCase pages-router files', () => {
    // Real-world fr-school-ai case: `src/pages/DashboardStudent.jsx` → `/dashboard-student`
    const r = detectFileBasedRoutes('src/pages/DashboardStudent.jsx');
    expect(r[0]?.path).toBe('/dashboard-student');
  });

  it('handles acronym + word boundaries (HTMLForm → /html-form)', () => {
    const r = detectFileBasedRoutes('src/pages/HTMLForm.jsx');
    expect(r[0]?.path).toBe('/html-form');
  });

  it('lowercases simple PascalCase Remix routes (Files.tsx → /files)', () => {
    const r = detectFileBasedRoutes('src/routes/Files.tsx');
    expect(r[0]?.path).toBe('/files');
    expect(r[0]?.framework).toBe('remix');
  });

  it('kebab-cases compound Remix v7 routes (UserProfile.tsx → /user-profile)', () => {
    const r = detectFileBasedRoutes('src/routes/UserProfile.tsx');
    expect(r[0]?.path).toBe('/user-profile');
  });

  it('preserves dynamic segment names verbatim (camelCase params unchanged)', () => {
    // `[userId]` is a param name from the source code — it should map to
    // `:userId` so the route file's TypeScript types still match.
    const r = detectFileBasedRoutes('pages/users/[userId].tsx');
    expect(r[0]?.path).toBe('/users/:userId');
  });
});

describe('detectSourceRoutes', () => {
  it('catches Express-style declarations', () => {
    const src = "import express from 'express';\nconst app = express();\napp.get('/health', (req, res) => res.sendStatus(200));\nrouter.post('/items', create);";
    const r = detectSourceRoutes('server.ts', src);
    expect(r.map((x) => x.method + ' ' + x.path).sort()).toEqual(['GET /health', 'POST /items']);
  });

  it('skips express patterns when express is not imported (no false positives from comment examples)', () => {
    // Without an express-family import, `app.get('/x')` is more likely a
    // method call on a plain object than a route declaration. The route
    // extractor's own source file demonstrates this — example regex strings
    // in comments must not be interpreted as routes.
    const src = "// example: app.get('/path', ...)\nconst routes = ['/foo', '/bar'];";
    const r = detectSourceRoutes('lib.ts', src);
    expect(r.length).toBe(0);
  });

  it('catches raw Node http.createServer handlers via req.method + url.pathname', () => {
    const src = `import { createServer } from 'node:http';
      const server = createServer((req, res) => {
        const url = new URL(req.url || '', 'http://localhost');
        if (req.method === 'POST' && url.pathname === '/api/foo') return ok(res);
        if (req.method === 'GET' && url.pathname === '/api/bar') return ok(res);
      });`;
    const r = detectSourceRoutes('apps/cli/src/server.ts', src);
    const keys = r.map((x) => x.framework + ' ' + (x.method ?? 'NULL') + ' ' + x.path).sort();
    expect(keys).toEqual(['node-http GET /api/bar', 'node-http POST /api/foo']);
  });

  it('catches FastAPI + Flask + Django patterns', () => {
    const py = `
      @app.get("/api/hello")
      async def hello(): return {}

      @app.route("/legacy", methods=["GET", "POST"])
      def legacy(): pass

      path("admin/", admin_view)
    `;
    const r = detectSourceRoutes('api.py', py);
    const paths = r.map((x) => x.framework + ':' + (x.method ?? '-') + ' ' + x.path).sort();
    expect(paths).toEqual([
      'django:GET admin/',
      'fastapi:GET /api/hello',
      'flask:GET /legacy',
      'flask:POST /legacy',
    ]);
  });
});
