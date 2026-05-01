#!/usr/bin/env node
/**
 * factstack — CXO + AI-agent codebase analyzer.
 *
 * v0.2 commands:
 *   factstack [path]           analyze <path> (default cwd) + emit artifacts
 *   factstack analyze [path]   alias for the default
 *   factstack ui [path]        open the WebUI in a browser
 *   factstack watch [path]     ui + chokidar + SSE live-update
 *   factstack diff [a] [b]     compare two analyses (snapshots or live agent.json)
 *   factstack query <verb>     callers / imports / cycles / orphans
 *   factstack export [path]    emit a self-contained HTML report (CDN-stripped)
 *   factstack doctor           sanity-check Node version + node:sqlite
 *
 * Top-level flags:
 *   --json                     machine-invocable mode for analyze/diff/query
 *
 * Companion: apps/mcp-server (factstack-mcp) — same artifacts over MCP stdio.
 */

import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Command } from 'commander';
import kleur from 'kleur';
import open from 'open';
import chokidar, { type FSWatcher } from 'chokidar';
import { analyze, buildMemory, diffArtifacts, executeQuery, type DiffEndpoint } from '@factstack/core';
import { extractOutline } from '@factstack/extractors';
import { gzippedBytes, humanToViz, readSnapshots, writeArtifacts } from '@factstack/emit';
import { mineGitStats, nodeFS } from '@factstack/fs-node';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { AgentArtifactSchema, HumanArtifactSchema, QUERY_VERBS } from '@factstack/spec';

const program = new Command();

program
  .name('factstack')
  .description('FACTS — AI Coding Tracker Stack. Analyse a project and emit AI-agent + CXO-readable artifacts.')
  .version('0.1.0-alpha.1')
  // Top-level `--json` so `factstack --json .` matches the file-header
  // promise of "machine-invocable mode (no TTY chrome)". Subcommands
  // that also support `--json` (analyze, diff, query) read the same
  // flag from `program.opts()` if not passed locally.
  .option('--json', 'Machine-invocable mode: structured JSON on stdout (works with analyze, diff, query)');

program
  .command('analyze [target]', { isDefault: true })
  .description('Analyze a project directory and write artifacts into <target>/.facts/')
  .option('--json', 'Emit machine-readable JSON to stdout instead of a TTY summary')
  .option('--no-progress', 'Suppress progress output')
  .option('--no-gitignore-entry', 'Do not add .facts/ to the project .gitignore')
  .action(async (target: string | undefined, opts: { json?: boolean; progress?: boolean; gitignoreEntry?: boolean }) => {
    // Inherit top-level --json if subcommand-local flag isn't set.
    if (opts.json === undefined && program.opts().json) opts.json = true;
    const root = path.resolve(target ?? '.');
    const machine = opts.json ?? false;
    // Precondition: target must exist and be a directory. Without this
    // we run the walker, get 0 files, then crash deep inside writeArtifacts
    // with `ENOTDIR: not a directory, mkdir <root>/.facts`. Catch early.
    try {
      const s = statSync(root);
      if (!s.isDirectory()) {
        process.stderr.write(kleur.red('factstack analyze: ') + kleur.cyan(root) + ' is not a directory.\n');
        process.stderr.write(kleur.dim('  pass a project root, e.g. `factstack analyze .`\n'));
        process.exit(1);
      }
    } catch {
      process.stderr.write(kleur.red('factstack analyze: ') + kleur.cyan(root) + ' does not exist.\n');
      process.exit(1);
    }
    const showProgress = !machine && (opts.progress ?? true);
    const t0 = performance.now();

    if (!machine) {
      process.stderr.write(kleur.bold().green('FACTS') + kleur.dim(' · analyzing ') + kleur.cyan(root) + '\n');
    }

    const fs = nodeFS(root);
    const projectName = path.basename(root);
    const gitStats = mineGitStats(root);
    let lastPrinted = 0;

    const result = await analyze(fs, {
      root: '.',
      projectName,
      gzip: gzippedBytes,
      gitStats,
      onProgress: showProgress
        ? (pct, file) => {
            const now = performance.now();
            // Throttle to 10 Hz for TTY friendliness.
            if (now - lastPrinted < 100 && pct < 1) return;
            lastPrinted = now;
            const width = 24;
            const filled = Math.round(pct * width);
            const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
            const label = file ? file.slice(-48).padEnd(48, ' ') : 'done'.padEnd(48, ' ');
            process.stderr.write(`\r  ${kleur.green(bar)} ${Math.round(pct * 100)}%  ${kleur.dim(label)}`);
            if (pct >= 1) process.stderr.write('\n');
          }
        : undefined,
    });

    const written = await writeArtifacts({
      root,
      agent: result.agent,
      human: result.human,
      addGitignoreEntry: opts.gitignoreEntry ?? true,
      writeSnapshot: true,
      memoryBody: buildMemory(result.agent, result.human),
    });

    const elapsed = performance.now() - t0;

    if (machine) {
      process.stdout.write(JSON.stringify({
        ok: true,
        elapsedMs: Math.round(elapsed),
        ...written,
        stats: result.agent.stats,
        risks: result.agent.risks.length,
      }, null, 2) + '\n');
      return;
    }

    // Pretty summary
    const s = result.agent.stats;
    const lines = [
      '',
      kleur.bold('  Summary'),
      kleur.dim('  ───────'),
      `  files        ${kleur.white(String(s.fileCount))}`,
      `  LOC          ${kleur.white(formatCount(s.loc))}`,
      `  tokens       ${kleur.white(formatCount(s.totalTokenCost))}${kleur.dim(' (cl100k approx)')}`,
      `  risks        ${result.agent.risks.length === 0 ? kleur.green('0') : kleur.yellow(String(result.agent.risks.length))}`,
      `  frameworks   ${kleur.white(result.agent.project.frameworks.join(', ') || '—')}`,
      '',
      kleur.bold('  Artifacts'),
      kleur.dim('  ─────────'),
      `  ${kleur.green('✓')} ${relativize(written.agentPath, root)}`,
      `  ${kleur.green('✓')} ${relativize(written.humanPath, root)}`,
      written.jsonlPath ? `  ${kleur.green('✓')} ${relativize(written.jsonlPath, root)}` : '',
      '',
      kleur.dim(`  Done in ${elapsed.toFixed(0)} ms. Total ${formatBytes(written.bytesWritten)} written.`),
      '',
    ];
    process.stderr.write(lines.filter(Boolean).join('\n') + '\n');
  });

program
  .command('ui [target]')
  .description('Open the WebUI in a browser, pointed at <target>/.facts/ artifacts')
  .option('-p, --port <port>', 'Port to serve on (default 4747)', '4747')
  .option('--no-open', "Don't auto-open the browser")
  .option('--reanalyze', 'Re-run analysis before starting the server')
  .option('-w, --watch', 'Watch source files and push live updates via SSE')
  .action(async (target: string | undefined, opts: { port: string; open: boolean; reanalyze?: boolean; watch?: boolean }) => {
    const root = path.resolve(target ?? '.');
    const factsDir = path.join(root, '.facts');
    const agentPath = path.join(factsDir, 'agent.json');
    const humanPath = path.join(factsDir, 'human.json');

    if (opts.reanalyze || !existsSync(humanPath) || !existsSync(agentPath)) {
      process.stderr.write(
        kleur.dim(!existsSync(humanPath)
          ? '  no existing .facts/ — running analysis first…\n'
          : '  re-analyzing before serving…\n'),
      );
      const fs = nodeFS(root);
      const result = await analyze(fs, { root: '.', projectName: path.basename(root), gzip: gzippedBytes, gitStats: mineGitStats(root) });
      await writeArtifacts({ root, agent: result.agent, human: result.human, addGitignoreEntry: true, memoryBody: buildMemory(result.agent, result.human) });
    }

    let agent: AgentArtifact;
    let human: HumanArtifact;
    try {
      agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
      human = loadAndValidate<HumanArtifact>(humanPath, 'human');
    } catch (err) {
      process.stderr.write(kleur.red('factstack ui: ') + (err instanceof Error ? err.message : String(err)) + '\n');
      process.stderr.write(kleur.dim('  run `factstack analyze .` to regenerate, or `factstack ui --reanalyze` to re-run now.\n'));
      process.exit(1);
    }
    let viz = humanToViz(agent, human);
    // Overlay the absolute path so the UI's project chip shows the real
    // location instead of the analyzer's relative "." root.
    viz.project.root = root;
    viz.history = await readSnapshots(root);

    const template = readUiTemplate();
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
        try { send(event, data); } catch { /* ignore dead clients */ }
      }
    }

    // Shared analyze-and-push used by both user clicks and the watcher.
    // Returns the freshly-written stats so callers can send a confirmation.
    async function reanalyzeAndPush(reason: 'user' | 'watch'): Promise<AgentArtifact['stats']> {
      const fs = nodeFS(root);
      const result = await analyze(fs, { root: '.', projectName: path.basename(root), gzip: gzippedBytes, gitStats: mineGitStats(root) });
      await writeArtifacts({ root, agent: result.agent, human: result.human, addGitignoreEntry: true, writeSnapshot: true, memoryBody: buildMemory(result.agent, result.human) });
      const fresh = humanToViz(result.agent, result.human);
      fresh.project.root = root;
      fresh.history = await readSnapshots(root);
      cached = injectInlineData(template, fresh);
      viz = fresh;
      broadcast('update', { reason, stats: result.agent.stats, generatedAt: fresh.generatedAt });
      return result.agent.stats;
    }

    const port = Number(opts.port) || 4747;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/api/reanalyze') {
        // Two promise flows:
        //   1. the serial chain — user + watch requests hit analyze() one at
        //      a time so writeArtifacts() can't race and tear the on-disk
        //      agent.json.
        //   2. THIS request's response — resolves when THIS analyze finishes,
        //      not when the whole chain drains. Previously a watcher-queued
        //      run ahead of the user click would hold the browser for both.
        const thisRun: Promise<AgentArtifact['stats']> = reanalyzeChain
          .then(() => reanalyzeAndPush('user'));
        reanalyzeChain = thisRun.catch(() => undefined);
        thisRun
          .then((stats) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, stats }));
          })
          .catch((err: unknown) => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        // Server-Sent Events stream. Held open for the life of the tab.
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',              // disable nginx-style proxy buffering
        });
        res.write(': hello\n\n');
        const send: SseSender = (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        sseClients.add(send);
        // Heartbeat every 20s so intermediaries don't GC the connection.
        const heartbeat = setInterval(() => {
          try { res.write(': ping\n\n'); } catch { /* ignore */ }
        }, 20_000);
        req.on('close', () => {
          clearInterval(heartbeat);
          sseClients.delete(send);
        });
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(cached);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/data/factstack.json') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(viz));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/outline') {
        const relRaw = url.searchParams.get('path') || '';
        const rel = relRaw.replace(/\\/g, '/').replace(/^\.\//, '');
        const abs = safeResolveInside(root, rel);
        if (!abs) {
          res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden'); return;
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
            res.end(JSON.stringify({ outline: [], source: null, path: rel, error: 'file too large' }));
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
        const rel = relRaw.replace(/\\/g, '/').replace(/^\.\//, '');
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
          res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden'); return;
        }
        if (!existsSync(abs)) {
          res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
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
            res.writeHead(413, { 'content-type': 'text/plain' }); res.end('file too large (2MB cap)'); return;
          }
          const buf = readFileSync(abs);
          // Cheap binary detect: reject if NUL in first 8KB.
          if (buf.slice(0, 8192).includes(0)) {
            res.writeHead(415, { 'content-type': 'text/plain' }); res.end('binary'); return;
          }
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
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

    // Friendly error for the common "port in use" case — a stack trace
    // scares users and `node:http` emits EADDRINUSE via the error event
    // rather than rejecting the listen() promise.
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(kleur.red('factstack ui: ') + `port ${port} is in use.\n`);
        process.stderr.write(kleur.dim(`  try a different port: factstack ui --port ${port + 1}\n`));
        process.exit(1);
      }
      process.stderr.write(kleur.red('factstack ui: ') + err.message + '\n');
      if (process.env.FACTSTACK_DEBUG && err.stack) process.stderr.write(err.stack + '\n');
      process.exit(1);
    });

    server.listen(port, () => {
      const url = `http://localhost:${port}/`;
      const mode = opts.watch ? ' (watch)' : '';
      process.stderr.write(kleur.bold().green('FACTS UI' + mode) + kleur.dim(' · serving ') + kleur.cyan(url) + '\n');
      process.stderr.write(kleur.dim('  project: ') + agent.project.name + kleur.dim(' · ') + kleur.dim(root) + '\n');
      process.stderr.write(kleur.dim('  press Ctrl-C to stop') + '\n');
      if (opts.open !== false) open(url).catch(() => { /* ignore */ });
    });

    // Watch mode: chokidar → 500ms debounce → reanalyzeChain → SSE push.
    // Excludes `.facts/**` to prevent write→watch→write feedback loops,
    // `node_modules/**` / build outputs to stay under Windows watch-FD
    // limits, and `.git/` for the same reason.
    let watcher: FSWatcher | null = null;
    if (opts.watch) {
      watcher = chokidar.watch(root, {
        ignored: [
          /(^|[/\\])\.facts([/\\]|$)/,
          /(^|[/\\])node_modules([/\\]|$)/,
          /(^|[/\\])\.git([/\\]|$)/,
          /(^|[/\\])(dist|build|\.next|\.turbo|\.cache)([/\\]|$)/,
        ],
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      });
      let debounce: ReturnType<typeof setTimeout> | null = null;
      watcher.on('all', () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = null;
          reanalyzeChain = reanalyzeChain.then(() => reanalyzeAndPush('watch').catch((err: unknown) => {
            broadcast('error', { message: err instanceof Error ? err.message : String(err) });
          }));
        }, 500);
      });
      process.stderr.write(kleur.dim('  watching source files — edits will re-analyze + push updates\n'));
    }

    // On Ctrl-C, close the watcher, close keep-alive sockets, then close
    // the server. All three are required or the process hangs until the
    // browser tab closes.
    const stop = () => {
      try { watcher?.close(); } catch { /* ignore */ }
      try { (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); }
      catch { /* ignore older Node */ }
      server.close(() => process.exit(0));
      // Hard timeout: if close takes >3s, exit anyway.
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

// `factstack watch` — convenience alias for `factstack ui --watch`. Same
// server, same endpoints, just launches with the watcher on by default.
program
  .command('watch [target]')
  .description('Run the UI with live file-watching + SSE push. Alias for `ui --watch`.')
  .option('-p, --port <port>', 'Port to serve on (default 4747)', '4747')
  .option('--no-open', "Don't auto-open the browser")
  .action(async (target: string | undefined, opts: { port: string; open: boolean }) => {
    // Delegate to the `ui` command's action via the program's argv re-parse.
    const argv = ['node', 'factstack', 'ui', '--watch', '--port', opts.port];
    if (target) argv.splice(3, 0, target);
    if (opts.open === false) argv.push('--no-open');
    await program.parseAsync(argv);
  });

program
  .command('export [target]')
  .description('Emit a self-contained HTML report (no server needed to view)')
  .option('-o, --out <dir>', 'Output directory (default ./dist)', './dist')
  .option('--name <name>', 'Output filename (default facts-report.html)', 'facts-report.html')
  .action(async (target: string | undefined, opts: { out: string; name: string }) => {
    const root = path.resolve(target ?? '.');
    const factsDir = path.join(root, '.facts');
    const agentPath = path.join(factsDir, 'agent.json');
    const humanPath = path.join(factsDir, 'human.json');

    if (!existsSync(humanPath) || !existsSync(agentPath)) {
      process.stderr.write(kleur.dim('  no existing .facts/ — analyzing first…\n'));
      const fs = nodeFS(root);
      const result = await analyze(fs, { root: '.', projectName: path.basename(root), gzip: gzippedBytes, gitStats: mineGitStats(root) });
      await writeArtifacts({ root, agent: result.agent, human: result.human, addGitignoreEntry: true, memoryBody: buildMemory(result.agent, result.human) });
    }

    let agent: AgentArtifact;
    let human: HumanArtifact;
    try {
      agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
      human = loadAndValidate<HumanArtifact>(humanPath, 'human');
    } catch (err) {
      process.stderr.write(kleur.red('factstack export: ') + (err instanceof Error ? err.message : String(err)) + '\n');
      process.stderr.write(kleur.dim('  run `factstack analyze .` to regenerate.\n'));
      process.exit(1);
    }
    const viz = humanToViz(agent, human);
    viz.project.root = root;
    viz.history = await readSnapshots(root);

    const template = readUiTemplate();
    // Strip CDN-loaded deps so the exported HTML opens cleanly via
    // file:// (no offline-broken Tailwind CDN, no Google Fonts CSP, no
    // dynamic esm.sh imports). See stripCdnDeps for what's removed.
    const stripped = stripCdnDeps(template);
    const out = injectInlineData(stripped, viz);

    const outDir = path.resolve(opts.out);
    mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, opts.name);
    writeFileSync(outPath, out, 'utf8');

    const size = statSync(outPath).size;
    process.stderr.write(kleur.bold().green('FACTS') + kleur.dim(' · exported ') + kleur.cyan(relativize(outPath, process.cwd())) + kleur.dim(` (${formatBytes(size)})`) + '\n');
    process.stderr.write(kleur.dim('  open the file directly in a browser — no server required (CDN deps stripped).\n'));
  });

program
  .command('diff [snapshotA] [snapshotB]')
  .description('Compare two analyses. Zero args: current agent.json vs the latest snapshot. Two args: two snapshot files.')
  .option('--json', 'Emit the diff artifact as JSON on stdout instead of a TTY summary')
  .option('-r, --root <path>', 'Project root (default cwd)', '.')
  .action(async (snapA: string | undefined, snapB: string | undefined, opts: { json?: boolean; root: string }) => {
    if (opts.json === undefined && program.opts().json) opts.json = true;
    const root = path.resolve(opts.root);
    const factsDir = path.join(root, '.facts');
    const snapDir = path.join(factsDir, 'snapshots');

    // Load an AgentArtifact from either a full .facts/agent.json OR a
    // compact snapshot (.facts/snapshots/*.json — stored as a
    // stats-only rollup). Snapshots don't contain `files[]` so we fall
    // back to a synthetic AgentArtifact with enough shape for diffing
    // headline metrics.
    const loadEndpoint = (p: string): DiffEndpoint | null => {
      if (!existsSync(p)) return null;
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        // Heuristic: full agent artifact has `files[]`; snapshot doesn't.
        if (Array.isArray(raw.files)) return { artifact: raw as AgentArtifact };
        // Snapshot → synthesize a minimal AgentArtifact.
        const synthetic: AgentArtifact = {
          $schema: 'https://factstack.dev/schema/agent.v1.json',
          factsVersion: '0.1.0',
          generatedAt: raw.at ?? new Date().toISOString(),
          project: { name: '', root: '', languages: [], frameworks: [], entryPoints: [], monorepo: null },
          files: [],
          graph: { nodes: [], edges: [], cycles: [] },
          routes: [],
          scripts: {},
          capabilities: [],
          risks: new Array(raw.risks ?? 0).fill(null).map(() => ({ severity: 'info' as const, category: 'stale' as const, rule: 'snapshot-placeholder', message: '' })),
          stats: {
            loc: raw.stats?.loc ?? 0,
            fileCount: raw.stats?.fileCount ?? 0,
            packageCount: 0,
            totalTokenCost: raw.stats?.totalTokenCost ?? 0,
          },
        };
        // Snapshots roll up headline counts (todos, broken, stale,
        // secrets) at the top level. Pass every known numeric field
        // through as an override so the diff reports real numbers
        // instead of always showing "0 → current" for each.
        const overrides: NonNullable<DiffEndpoint['overrides']> = {};
        if (typeof raw.todos === 'number')   overrides.todos = raw.todos;
        if (typeof raw.broken === 'number')  overrides.broken = raw.broken;
        if (typeof raw.stale === 'number')   overrides.stale = raw.stale;
        if (typeof raw.secrets === 'number') overrides.secrets = raw.secrets;
        return {
          artifact: synthetic,
          snapshotFile: p,
          ...(Object.keys(overrides).length ? { overrides } : {}),
        };
      } catch {
        return null;
      }
    };

    const resolveEndpoint = (arg: string | undefined): DiffEndpoint | null => {
      if (!arg) return null;
      // Accept a bare snapshot stamp, a full path, or a file in snapDir.
      const candidates = [
        arg,
        path.resolve(arg),
        path.join(snapDir, arg),
        path.join(snapDir, arg + '.json'),
      ];
      for (const c of candidates) {
        const loaded = loadEndpoint(c);
        if (loaded) return loaded;
      }
      return null;
    };

    let from: DiffEndpoint | null;
    let to:   DiffEndpoint | null;

    if (snapA && snapB) {
      // Two-arg: explicit snapshots.
      from = resolveEndpoint(snapA);
      to   = resolveEndpoint(snapB);
    } else if (snapA && !snapB) {
      // One-arg: named snapshot vs current agent.json.
      from = resolveEndpoint(snapA);
      to   = loadEndpoint(path.join(factsDir, 'agent.json'));
    } else {
      // Zero-arg: PREVIOUS snapshot (not most recent) vs current
      // agent.json. The most recent snapshot was almost certainly
      // written by the same `analyze` run that produced agent.json,
      // so picking it would diff against itself and report zero deltas.
      // Pick the second-to-last to actually surface change. Falls back
      // to the only-snapshot if there's just one.
      from = existsSync(snapDir)
        ? (() => {
            const files = (statSync(snapDir).isDirectory() ? readdirSnapshotList(snapDir) : []);
            if (!files.length) return null;
            const pick = files[files.length - 2] ?? files[files.length - 1]!;
            return resolveEndpoint(pick);
          })()
        : null;
      to = loadEndpoint(path.join(factsDir, 'agent.json'));
    }

    if (!from || !to) {
      process.stderr.write(kleur.red('factstack diff: ') + 'need two analyzable endpoints.\n');
      if (!from) process.stderr.write(kleur.dim('  "from" not found — pass a snapshot path or run factstack analyze first to populate .facts/snapshots/\n'));
      if (!to)   process.stderr.write(kleur.dim('  "to" not found — run factstack analyze to produce .facts/agent.json\n'));
      process.exit(1);
    }

    const diff = diffArtifacts(from, to);

    if (opts.json) {
      process.stdout.write(JSON.stringify(diff, null, 2) + '\n');
      return;
    }

    // Editorial TTY table: prose lead + three-line stat delta block + file
    // counts. No ASCII-art: the CLI has a consistent `Summary` + `Artifacts`
    // block style already (see `analyze` action); match it.
    const s = diff.stats;
    const line = (label: string, d: { before: number; after: number; delta: number }) => {
      const arrow = d.delta === 0 ? kleur.dim('→') : d.delta > 0 ? kleur.yellow('↑') : kleur.green('↓');
      const deltaStr = (d.delta >= 0 ? '+' : '') + d.delta;
      return `  ${label.padEnd(10)} ${arrow} ${formatCount(Math.abs(d.delta)).padStart(6)}${kleur.dim(' (was ' + formatCount(d.before) + ', now ' + formatCount(d.after) + ')')}`;
    };
    const lines = [
      '',
      kleur.bold('  Diff'),
      kleur.dim('  ────'),
      `  from ${kleur.white(diff.from.at)}`,
      `  to   ${kleur.white(diff.to.at)}`,
      '',
      line('files',   s.files),
      line('LOC',     s.loc),
      line('tokens',  s.tokens),
      line('risks',   s.risks),
      line('TODOs',   s.todos),
      line('secrets', s.secrets),
      '',
      diff.files.incomplete
        ? kleur.dim('  per-file diff unavailable (one endpoint is a snapshot rollup; compare two full agent.json files for added/removed)')
        : kleur.dim('  ' + diff.files.added.length + ' added, ' + diff.files.removed.length + ' removed, ' + diff.files.changed.length + ' changed'),
      '',
    ];
    process.stderr.write(lines.join('\n') + '\n');
  });

program
  .command('query <verb> [target]')
  .description('Query the dependency graph. Verbs: callers <path> | imports <path> | cycles | orphans')
  .option('--json', 'Emit structured JSON on stdout instead of a TTY list')
  .option('-r, --root <path>', 'Project root (default cwd)', '.')
  .option('-f, --filter <glob>', 'Restrict results to matching paths')
  .option('-l, --limit <n>', 'Max results (default 200)', '200')
  .option('-d, --depth <n>', 'Transitive depth for `imports` verb (default 1)', '1')
  .action(async (verb: string, target: string | undefined, opts: { json?: boolean; root: string; filter?: string; limit: string; depth: string }) => {
    if (opts.json === undefined && program.opts().json) opts.json = true;
    // Verb set is the single-source-of-truth `QUERY_VERBS` from @factstack/spec.
    if (!(QUERY_VERBS as readonly string[]).includes(verb)) {
      process.stderr.write(kleur.red('factstack query: ') + `unknown verb "${verb}". Expected: ${QUERY_VERBS.join(', ')}\n`);
      process.exit(1);
    }
    if ((verb === 'callers' || verb === 'imports') && !target) {
      process.stderr.write(kleur.red('factstack query: ') + `verb "${verb}" requires a target path.\n`);
      process.stderr.write(kleur.dim(`  example: factstack query ${verb} packages/core/src/index.ts\n`));
      process.exit(1);
    }
    // Numeric option guards — `Number('nope')` is NaN, which the
    // downstream `slice(0, NaN)` and `for (let i = 0; i < NaN; …)` paths
    // silently treat as 0, producing empty results with no signal. Parse
    // strictly + clamp to sane positive integers, falling back to defaults.
    const limit = parseIntInRange(opts.limit, 200, 1, 100_000);
    const depth = parseIntInRange(opts.depth, 1,   0, 50);
    const root = path.resolve(opts.root);
    const agentPath = path.join(root, '.facts', 'agent.json');
    let agent: AgentArtifact;
    try {
      agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
    } catch (err) {
      process.stderr.write(kleur.red('factstack query: ') + (err instanceof Error ? err.message : String(err)) + '\n');
      process.stderr.write(kleur.dim('  run `factstack analyze .` first.\n'));
      process.exit(1);
    }
    const result = executeQuery(agent, {
      verb: verb as typeof QUERY_VERBS[number],
      ...(target ? { path: target } : {}),
      ...(opts.filter ? { filter: opts.filter } : {}),
      limit,
      depth,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }
    const header = target
      ? `${verb}(${target}) — ${result.count} result${result.count === 1 ? '' : 's'}`
      : `${verb} — ${result.count} result${result.count === 1 ? '' : 's'}`;
    process.stderr.write(kleur.bold(header) + '\n');
    const rows = result.results as unknown;
    if (verb === 'cycles') {
      // cycles are arrays of paths; print one cycle per indented block.
      for (const cyc of rows as string[][]) {
        process.stderr.write(kleur.dim('  ─── cycle ───\n'));
        for (const p of cyc) process.stderr.write('  ' + p + '\n');
      }
    } else {
      for (const r of rows as string[]) process.stderr.write('  ' + r + '\n');
    }
  });

program
  .command('doctor')
  .description('Verify FACTS can analyse this machine (Node version, permissions, etc.)')
  .action(async () => {
    const checks: Array<{ label: string; ok: boolean; detail: string }> = [];
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    checks.push({
      label: 'Node ≥ 20',
      ok: nodeMajor >= 20,
      detail: `found v${process.versions.node}`,
    });
    // node:sqlite (v0.2 target, but pre-check). It's a Node 22+ experimental
    // API that @types/node doesn't ship typings for; use a dynamic spec
    // string so TS doesn't try to resolve it at type-check time.
    try {
      const sqliteSpec: string = 'node:sqlite';
      const sqlite = await import(sqliteSpec).catch(() => null);
      checks.push({
        label: 'node:sqlite available',
        ok: sqlite !== null,
        detail: sqlite ? 'ok' : 'upgrade to Node 22+ for v0.2 SQLite index',
      });
    } catch {
      checks.push({ label: 'node:sqlite available', ok: false, detail: 'not available' });
    }
    for (const c of checks) {
      const mark = c.ok ? kleur.green('✓') : kleur.red('✗');
      process.stderr.write(`  ${mark} ${c.label.padEnd(28, ' ')} ${kleur.dim(c.detail)}\n`);
    }
    process.exit(checks.every((c) => c.ok) ? 0 : 1);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(kleur.red('factstack: ') + message + '\n');
  if (process.env.FACTSTACK_DEBUG && err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  process.exit(1);
});

/* -------------------------------- utils ------------------------------- */

function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1_048_576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return `${n} B`;
}

function relativize(p: string, root: string): string {
  return path.relative(root, p).replace(/\\/g, '/');
}

/**
 * Return the lexicographically-sorted list of full snapshot JSON file
 * paths under `.facts/snapshots/`. ISO-stamp filenames make lexi-sort
 * equivalent to chrono-sort, so the last element is "most recent."
 */
function readdirSnapshotList(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch { return []; }
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
function safeResolveInside(root: string, rel: string): string | null {
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
    if (!isInside(rootAbs, real)) return null;
    return real;
  } catch {
    return abs;
  }
}

/**
 * Parse a CLI numeric option strictly. Returns the parsed integer if it
 * lies in [min, max]; otherwise returns `def`. Guards against `Number()`'s
 * NaN-on-bad-input which cascades into silent zero behavior in slice/loop
 * code downstream.
 */
function parseIntInRange(raw: string | number, def: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Returns true iff `candidate` is `root` itself or a descendant of it. */
function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  // Empty `rel` → same path; otherwise `rel` must not begin with `..` and
  // must not be an absolute path (the latter happens on Windows when
  // root + candidate live on different drives).
  if (rel === '') return true;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Parse a `.facts/*.json` artifact and re-validate it against its schema
 * so we get a useful error message on corruption instead of a cryptic
 * crash deep inside `humanToViz`. The `kind` is used for the error text.
 */
function loadAndValidate<T>(p: string, kind: 'agent' | 'human'): T {
  let raw: string;
  try { raw = readFileSync(p, 'utf8'); }
  catch (err) {
    throw new Error(`cannot read ${relativize(p, process.cwd())} — ${(err as Error).message}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    throw new Error(`${relativize(p, process.cwd())} is not valid JSON (${(err as Error).message}). Re-run factstack analyze.`);
  }
  const schema = kind === 'agent' ? AgentArtifactSchema : HumanArtifactSchema;
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.errors[0];
    const where = first ? first.path.join('.') : '(unknown)';
    throw new Error(`${relativize(p, process.cwd())} has an invalid shape at ${where}. The analyzer may be a different version — re-run factstack analyze.`);
  }
  return result.data as T;
}

/**
 * Locate the shipped prototype HTML. In dev (tsx) we live at
 * apps/cli/src/cli.ts → template at apps/cli/src/ui/index.html. After
 * `pnpm build` the compiled output lives at apps/cli/dist/cli.js and
 * the sync-ui script has copied the HTML to apps/cli/dist/ui/index.html.
 */
function readUiTemplate(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'ui', 'index.html'),
    path.join(here, '..', 'src', 'ui', 'index.html'),
    path.join(here, '..', '..', 'src', 'ui', 'index.html'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf8');
  }
  throw new Error('UI template not found. Run `pnpm --filter @factstack/cli sync:ui`.');
}

/**
 * Replace the prototype's inline <script id="factstack-data" …>…</script>
 * body with fresh analysis data. Matches the same marker used by
 * prototype/scripts/inject-data.mjs so both paths stay aligned.
 */
/**
 * Strip CDN-loaded scripts + stylesheets from the exported HTML so the
 * output honors the C3 promise of "self-contained — open via file://".
 *
 * Removes:
 *   - <link rel="stylesheet" href="https://...">
 *   - <link href="https://fonts.googleapis.com/...">
 *   - <link href="https://fonts.gstatic.com/...">
 *   - <script src="https://...">
 *   - inline `import('https://esm.sh/...')` blocks (Open-folder uses
 *     this to lazy-load @babel/parser; the static export drops it).
 *
 * The prototype is editorial-styled enough that fonts/Tailwind missing
 * degrades gracefully (system fonts, no utility CSS) but the layout
 * survives. Real font + CSS bundling lands with the Vite static build
 * in v0.3 (apps/ui-remix `build:static` target).
 */
function stripCdnDeps(html: string): string {
  let out = html;
  // Remove <link rel="stylesheet" href="https://..."> (any quote style).
  out = out.replace(/<link\s+[^>]*?href=["']https?:\/\/[^"']+["'][^>]*?>/gi, '');
  // Remove <script src="https://...">…</script> (with or without body).
  out = out.replace(/<script\s+[^>]*?src=["']https?:\/\/[^"']+["'][^>]*?>\s*<\/script>/gi, '');
  // Replace any `import('https://...')` call expression with a stub that
  // throws a friendly error. Catches the prototype's lazy `_babelParser`
  // load (`(await import('https://esm.sh/@babel/parser')).parse;`) which
  // would otherwise contact esm.sh at runtime — failing under file://
  // and any CSP that disallows third-party origins. The Open-folder
  // workflow this powers is incoherent in static export anyway (there
  // is no server to re-analyze against).
  out = out.replace(
    /import\(\s*['"]https?:\/\/[^'"]+['"]\s*\)/gi,
    `Promise.reject(new Error('Open-folder requires the served WebUI; static exports cannot dynamically load remote modules.'))`,
  );
  return out;
}

function injectInlineData(html: string, data: unknown): string {
  const start = '<script id="factstack-data" type="application/json">';
  const i = html.indexOf(start);
  if (i < 0) throw new Error('data marker not found in UI template');
  const after = i + start.length;
  const end = html.indexOf('</script>', after);
  if (end < 0) throw new Error('closing </script> not found after data marker');
  // Escape "</script" inside strings so the inline block stays well-formed
  // (the same trick the CDN-less prototype uses).
  const safeJson = JSON.stringify(data).replace(/<\/script/gi, '<\\/script');
  return html.slice(0, after) + '\n' + safeJson + '\n    ' + html.slice(end);
}
