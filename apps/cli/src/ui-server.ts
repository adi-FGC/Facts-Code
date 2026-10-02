/**
 * The `factstack ui` HTTP server and its guards (tech-debt#6). Everything
 * that decides what a page reaching this localhost server may do lives here
 * as exported functions, so each guard is unit-tested on its own
 * (test/ui-server.test.ts) instead of only through a spawned binary:
 *
 *   isOriginAllowed    CSRF / DNS-rebind: Origin, then Host, default-deny
 *   isCrossSiteFetch   CLI-14: Fetch Metadata for no-Origin cross-site loads
 *   safeResolveInside  path containment for /api/file + /api/outline,
 *                      symlink escapes included
 *   readBody           request-body size cap for POST handlers
 *   createUiServer     the routes: the hash-only CSP page, /data, /vendor/*,
 *                      /api/{reanalyze,setup-agents,deps-outdated,recent,
 *                      events,outline,file} (2 MB file cap, binary refusal)
 *
 * The `ui` command (commands/ui.ts) owns the process around it: the start-up
 * analyze, listen, the idle timer, the file watcher and Ctrl-C.
 */

import path from 'node:path';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { extractOutline } from '@factstack/extractors';
import { humanToViz, readSnapshots, type VizArtifact } from '@factstack/emit';
import { checkOutdated, summarizeOutdated } from '@factstack/scanners';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { hookLaunchNote, installFreshnessHook } from './agentHook.js';
import { loadAndValidate } from './artifacts.js';
import { writeSkillFiles } from './commands/skillFiles.js';
import { injectInlineData, readVendorModule, uiContentSecurityPolicy } from './ui/embed.js';
import { planOutdatedQueries, readLockfiles } from './vulns.js';

/**
 * Read a request body with a hard size cap (ft-8). POST handlers (exec,
 * folder browse) use this so a malicious or runaway client can't stream an
 * unbounded body into memory. Default 1 MB — far above any real payload.
 */
export function readBody(req: IncomingMessage, limit = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer | string) => {
      body += chunk;
      if (body.length > limit) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ───────── ft-6: server-backed folder browser + recents ─────────

/** Recently-served projects, at ~/.factstack/recent.json (last 10). */
export const RECENT_FILE = path.join(homedir(), '.factstack', 'recent.json');

export function loadRecent(
  file: string = RECENT_FILE,
): Array<{ path: string; name: string; scannedAt: string }> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addRecent(folderPath: string, file: string = RECENT_FILE): void {
  try {
    const entry = {
      path: folderPath,
      name: path.basename(folderPath),
      scannedAt: new Date().toISOString(),
    };
    const list = [entry, ...loadRecent(file).filter((r) => r.path !== folderPath)].slice(0, 10);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(list, null, 2));
  } catch {
    // best-effort — recents are a convenience, never load-bearing
  }
}

/* CLI-13: the ft-5/6/7 endpoints POST /api/exec, GET /api/browse and GET
   /api/file-history were removed — no shipped UI calls them, /api/exec could
   not launch half its editors (Windows .cmd shims, wrong agent-CLI flags), and
   each one widened what a page reaching this localhost server could do. */

/** The Host values a request to this server may carry (the dashboard only
 *  ever calls its own origin, on 127.0.0.1 / localhost / [::1]). */
function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

/**
 * ft-8 security base: reject cross-origin requests (CSRF / DNS-rebind
 * defense). The dashboard only ever calls its own origin; a malicious
 * page that hits this localhost server gets a 403. Origin is present on
 * POSTs + cross-origin requests; Host is present on every HTTP/1.1 request.
 */
export function isOriginAllowed(r: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const allowed = allowedHosts(port);
  const origin = r.headers.origin;
  if (origin === 'null') return false; // opaque origin (file://, data:, sandboxed iframe)
  if (origin) {
    try {
      return allowed.has(new URL(origin).host);
    } catch {
      return false;
    }
  }
  const host = r.headers.host;
  if (host) return allowed.has(host);
  // No Origin AND no Host: unreachable from a browser (Host is mandatory
  // and browser-controlled on HTTP/1.1), so the CSRF/DNS-rebind vectors
  // this guards are already caught above. The only requests landing here
  // are non-browser clients (HTTP/1.0, raw sockets). Default-DENY — a
  // server with a filesystem-write endpoint (/api/setup-agents) must never
  // fall open. A scripted client can set an explicit Host header.
  return false;
}

/* CLI-14: browsers send NO Origin on a cross-site GET subresource load
   (`<script src="http://127.0.0.1:4747/api/file?…">`), so the Host
   fallback above let another site pull project files in as script. Fetch
   Metadata closes that: only a same-origin request, or one the user
   typed / bookmarked ('none'), gets through. Non-browser clients send no
   Sec-Fetch-Site and are unaffected. One exception: a top-level
   navigation to the dashboard page itself (a link from another site) —
   the linking page cannot read it, and CSP frame-ancestors forbids
   framing it. */
export function isCrossSiteFetch(r: Pick<IncomingMessage, 'headers' | 'method' | 'url'>): boolean {
  const first = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h)?.toLowerCase();
  const site = first(r.headers['sec-fetch-site']);
  if (site === undefined || site === 'same-origin' || site === 'none') return false;
  const pathname = (r.url ?? '/').split('?')[0];
  const pageNavigation =
    r.method === 'GET' &&
    (pathname === '/' || pathname === '/index.html') &&
    first(r.headers['sec-fetch-mode']) === 'navigate' &&
    first(r.headers['sec-fetch-dest']) === 'document';
  return !pageNavigation;
}

/**
 * Resolve a user-supplied relative path inside `root` with defense
 * against symlink escapes. Returns null (caller should 403) if:
 *   - the string-resolved target escapes root, OR
 *   - the immediate path is a symlink (we don't follow user-created
 *     symlinks because `realpathSync` would silently widen the scope), OR
 *   - `realpathSync` on the target resolves outside root.
 * The check is two-phase so non-existent targets still get a clean 404
 * via the existsSync() check the caller does next.
 */
export function safeResolveInside(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  const rootAbs = path.resolve(root);
  // Cross-platform "is candidate inside root?" check using path.relative,
  // which normalizes case + separators on Windows. Pure prefix comparison
  // (the previous implementation) false-positives on:
  //   - Windows drive-letter casing differences ("D:\Repo" vs "d:\repo")
  //   - Filesystem-root projects where rootAbs is "/" or "C:\" (trailing
  //     separator absent)
  //   - Sibling dirs that share a string prefix (e.g. "/var/lib" vs
  //     "/var/libfoo")
  if (!isInside(rootAbs, abs)) return null;
  // Reject symlinks at the leaf so `.facts-peek → /etc/passwd` can't read
  // outside the project. If a directory in the middle of the path is a
  // symlink, realpathSync will surface it below.
  try {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) return null;
  } catch {
    // File doesn't exist yet — let the caller return 404.
    return abs;
  }
  try {
    const real = realpathSync(abs);
    /* Compare real path with real path. A root reached through a
       symlink or junction (or macOS /tmp → /private/tmp) never contained
       its own files when `real` was checked against the unresolved root. */
    if (!isInside(realRoot(rootAbs), real)) return null;
    return real;
  } catch {
    return abs;
  }
}

/** `root` with symlinks and junctions resolved, best effort: as given when
 *  it cannot be resolved (the containment check then fails closed). */
function realRoot(rootAbs: string): string {
  try {
    return realpathSync(rootAbs);
  } catch {
    return rootAbs;
  }
}

/** Returns true iff `candidate` is `root` itself or a descendant of it. */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  // Empty `rel` → same path; otherwise `rel` must not begin with `..` and
  // must not be an absolute path (the latter happens on Windows when
  // root + candidate live on different drives).
  if (rel === '') return true;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

export interface UiServerOptions {
  /** Absolute project root; `.facts/` artifacts are read from under it. */
  root: string;
  /** The port the server will listen on — the only Host/Origin it accepts. */
  port: number;
  /** The UI template (readUiTemplate); its inline-script hashes are the CSP. */
  template: string;
  /** The dataset served at start-up (humanToViz + root + history). */
  viz: VizArtifact;
  /** Re-run the analyze pipeline and write .facts/ (POST /api/reanalyze and
   *  the watcher). Runs are serialized: never two at once. */
  reanalyze: () => Promise<{ agent: AgentArtifact; human: HumanArtifact }>;
  /** Called on every request and re-analyze (the `ui` idle timer). */
  onActivity?: () => void;
  /** Where /api/recent reads the recents list (default RECENT_FILE). */
  recentFile?: string;
}

export interface UiServer {
  /** The unstarted server: the caller listens on 127.0.0.1:port. */
  server: Server;
  /** Queue a watcher-triggered re-analyze behind any in-flight one. A
   *  failure is pushed to every open dashboard as an SSE `error` event. */
  queueWatchReanalyze(): void;
}

export function createUiServer(opts: UiServerOptions): UiServer {
  const { root, port, template, reanalyze } = opts;
  const factsDir = path.join(root, '.facts');
  const agentPath = path.join(factsDir, 'agent.json');
  const humanPath = path.join(factsDir, 'human.json');
  const recentFile = opts.recentFile ?? RECENT_FILE;
  const resetIdle = (): void => opts.onActivity?.();

  let viz = opts.viz;
  /* security#3/#4: scripts run only if their hash matches the shipped
     template (no 'unsafe-inline'), so an unescaped value that slipped
     into the page could still never execute. */
  const uiCsp = uiContentSecurityPolicy(template);
  let cached = injectInlineData(template, viz);

  // Serialize concurrent re-analyze calls so two overlapping POSTs can't
  // both race into writeArtifacts and leave a torn agent.json on disk.
  let reanalyzeChain: Promise<unknown> = Promise.resolve();

  // Live SSE subscribers. Each is a function that formats + writes
  // one event chunk to its client's response stream. Broadcast happens
  // after every successful analyze (user-triggered or watcher-triggered).
  type SseSender = (event: string, data: unknown) => void;
  const sseClients = new Set<SseSender>();
  function broadcast(event: string, data: unknown): void {
    for (const send of sseClients) {
      try {
        send(event, data);
      } catch {
        /* ignore dead clients */
      }
    }
  }

  // Shared analyze-and-push used by both user clicks and the watcher.
  // Returns the freshly-written stats so callers can send a confirmation.
  async function reanalyzeAndPush(reason: 'user' | 'watch'): Promise<AgentArtifact['stats']> {
    resetIdle();
    const result = await reanalyze();
    const fresh = humanToViz(result.agent, result.human);
    fresh.project.root = root;
    fresh.history = await readSnapshots(root);
    cached = injectInlineData(template, fresh);
    viz = fresh;
    broadcast('update', { reason, stats: result.agent.stats, generatedAt: fresh.generatedAt });
    return result.agent.stats;
  }

  const server = createServer((req, res) => {
    resetIdle();
    /* CLI-14: never let another origin read a response as script/style
       (nosniff) or embed it at all (CORP) — on every route, data too. */
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    if (!isOriginAllowed(req, port) || isCrossSiteFetch(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden: cross-origin request rejected');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/reanalyze') {
      // Two promise flows:
      //   1. the serial chain — user + watch requests hit analyze() one at
      //      a time so writeArtifacts() can't race and tear the on-disk
      //      agent.json.
      //   2. THIS request's response — resolves when THIS analyze finishes,
      //      not when the whole chain drains. Previously a watcher-queued
      //      run ahead of the user click would hold the browser for both.
      const thisRun: Promise<AgentArtifact['stats']> = reanalyzeChain.then(() =>
        reanalyzeAndPush('user'),
      );
      reanalyzeChain = thisRun.catch(() => {});
      thisRun
        .then((stats) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, stats }));
          return stats; // satisfy promise/always-return; value is unused (terminal chain)
        })
        .catch((err: unknown) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/setup-agents') {
      // "Set up FACTS for agents" (ft-1, Layer 3): install/refresh the
      // per-project skill files (Claude SKILL.md, .cursorrules, AGENTS.md,
      // .github/copilot-instructions.md) so AI coding agents read the FACTS
      // pack instead of re-scanning. Renders from the on-disk artifact
      // (kept fresh by reanalyze/watch) through writeSkillFiles, the write
      // path `export-skills`, `setup-agents` and `install` share.
      void (async () => {
        try {
          await readBody(req).catch(() => {}); // drain the POST body so the socket can't stall
          const a = loadAndValidate<AgentArtifact>(agentPath, 'agent');
          const h = loadAndValidate<HumanArtifact>(humanPath, 'human');
          /* Silent auto-export, the CLI's default rules: never clobber an
             existing AGENTS.md, or a .cursorrules / copilot-instructions.md
             without the FACTS marker; FACTS-managed ones are refreshed. */
          const result = await writeSkillFiles(root, a, h);
          // ft-1 Layer 2: install the PostToolUse freshness hook into
          // .claude/settings.local.json so the pack re-renders after every
          // agent edit. Non-fatal — the skills still install if this fails
          // (e.g. a settings file that is not valid JSON is refused, never
          // overwritten).
          let hookInstalled = false;
          let hookError: string | undefined;
          let hookNote: string | undefined;
          try {
            const hook = installFreshnessHook(
              root,
              process.env.FACTSTACK_HOOK_COMMAND || undefined,
            );
            hookInstalled = true;
            // The not-on-npm warning the CLI summaries print too.
            hookNote = hookLaunchNote(
              hook.command,
              'set FACTSTACK_HOOK_COMMAND, or run `setup-agents --hook-command <cmd>`',
            );
          } catch (e) {
            // Skills installed fine; surface WHY the (non-fatal) hook write
            // failed (EACCES/EROFS/…) instead of silently dropping it.
            hookError = e instanceof Error ? e.message : String(e);
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              formats: result.formats,
              files: Object.keys(result.files),
              // Report files left untouched (a hand-authored AGENTS.md) so the
              // dashboard caller can tell the user it was preserved, not skipped
              // silently — same contract as `export-skills`/`setup-agents` CLI.
              preserved: result.preserved,
              bytesWritten: result.bytesWritten,
              hookInstalled,
              ...(hookNote !== undefined ? { hookNote } : {}),
              ...(hookError ? { hookError } : {}),
            }),
          );
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      })();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/deps-outdated') {
      // ft-4: dependency freshness for the dashboard chip. Reads deps from
      // the on-disk artifact, checks each npm dep against the registry
      // `latest`, returns counts + the outdated list. Read-only (queries the
      // registry, writes nothing) — a GET is appropriate. Same installed-
      // version resolution as scan-vulns (lockfiles, npm: aliases).
      void (async () => {
        try {
          const a = loadAndValidate<AgentArtifact>(agentPath, 'agent');
          const { queries, skipped } = planOutdatedQueries(
            a.dependencyManifests,
            readLockfiles(root, a.dependencyManifests),
          );
          const results = await checkOutdated(queries, { concurrency: 8 });
          const { total, outdated, errored } = summarizeOutdated(results);
          res.writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          });
          res.end(
            JSON.stringify({
              ok: true,
              total,
              outdatedCount: outdated.length,
              errored,
              skipped,
              outdated: outdated.map((r) => ({
                name: r.name,
                current: r.current,
                latest: r.latest,
              })),
            }),
          );
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      })();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/recent') {
      // ft-6: recently-served projects (read-only).
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, recent: loadRecent(recentFile) }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      // Server-Sent Events stream. Held open for the life of the tab.
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no', // disable nginx-style proxy buffering
      });
      res.write(': hello\n\n');
      const send: SseSender = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      sseClients.add(send);
      // Heartbeat every 20s so intermediaries don't GC the connection.
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }, 20_000);
      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(send);
      });
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': uiCsp,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(cached);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/data/factstack.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(viz));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
      // Vendored ES modules built by scripts/sync-ui.mjs (today: @babel/parser
      // for the in-browser Open-folder scan). Allow-listed names only.
      const body = readVendorModule(url.pathname.slice('/vendor/'.length));
      if (body === null) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/outline') {
      const relRaw = url.searchParams.get('path') || '';
      const rel = relRaw.replaceAll('\\', '/').replace(/^\.\//, '');
      const abs = safeResolveInside(root, rel);
      if (!abs) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      if (!existsSync(abs)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ outline: [], source: null, path: rel, error: 'not found' }));
        return;
      }
      try {
        const s = statSync(abs);
        if (s.size > 2 * 1024 * 1024) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ outline: [], source: null, path: rel, error: 'file too large' }),
          );
          return;
        }
        const source = readFileSync(abs, 'utf8');
        const ext = (rel.match(/\.[^./\\]+$/)?.[0] || '').toLowerCase();
        const outline = extractOutline(source, ext);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ outline, path: rel, loc: source.split('\n').length, ext }));
      } catch (e: unknown) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ outline: [], error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/file') {
      const relRaw = url.searchParams.get('path') || '';
      const rel = relRaw.replaceAll('\\', '/').replace(/^\.\//, '');
      // Empty path → 400 instead of falling through to read root and
      // crashing with EISDIR. Also reject paths that resolve to the
      // project root itself (it's a directory, not a file).
      if (!rel) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('path query parameter required, e.g. /api/file?path=src/index.ts');
        return;
      }
      const abs = safeResolveInside(root, rel);
      if (!abs) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      if (!existsSync(abs)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      try {
        const s = statSync(abs);
        // Reject directories: trying to read one would EISDIR-throw and
        // surface as a 500. The /api/file endpoint is for files only.
        if (s.isDirectory()) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('path resolves to a directory, not a file');
          return;
        }
        if (s.size > 2 * 1024 * 1024) {
          res.writeHead(413, { 'content-type': 'text/plain' });
          res.end('file too large (2MB cap)');
          return;
        }
        const buf = readFileSync(abs);
        // Cheap binary detect: reject if NUL in first 8KB.
        if (buf.slice(0, 8192).includes(0)) {
          res.writeHead(415, { 'content-type': 'text/plain' });
          res.end('binary');
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          // script-src allows 'self': a project file must never be sniffed as script.
          'x-content-type-options': 'nosniff',
        });
        res.end(buf);
      } catch (e: unknown) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });

  return {
    server,
    queueWatchReanalyze(): void {
      reanalyzeChain = reanalyzeChain.then(() =>
        reanalyzeAndPush('watch').catch((err: unknown) => {
          broadcast('error', { message: err instanceof Error ? err.message : String(err) });
        }),
      );
    },
  };
}
