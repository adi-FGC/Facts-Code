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
import {
  analyze,
  buildChangeVerdict,
  buildDiagram,
  buildMemory,
  diffArtifacts,
  executeQuery,
  renderVerdictMarkdown,
  formatLearningEvent,
  selfCalibrateEvent,
  type DiagramView,
  type DiffEndpoint,
} from '@factstack/core';
import { extractOutline } from '@factstack/extractors';
import { gzippedBytes, humanToViz, NodeFileWriter, readSnapshots, writeArtifacts } from '@factstack/emit';
import { mineGitStats, nodeFS } from '@factstack/fs-node';
import {
  flattenManifests,
  queryOsvBatch,
  osvResultsToVulnerabilities,
  normalizeNpmVersion,
  noopCache,
  type OsvQuery,
} from '@factstack/scanners';
import { buildSkillsTo, ALL_FORMATS, type SkillFormatId } from '@factstack/skills';
import type { AgentArtifact, DiffArtifact, HumanArtifact, Vulnerability } from '@factstack/spec';
import { AgentArtifactSchema, HumanArtifactSchema, QUERY_VERBS } from '@factstack/spec';
import { renderCiReport } from './emitters/ci-report.js';
import { installFreshnessHook } from './agentHook.js';

const program = new Command();

program
  .name('factstack')
  .description('FACTS — Fun AI Coding Tools. Analyse a project and emit AI-agent + CXO-readable artifacts.')
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
  .option('--minimal', 'Write only the AI-first core: agent.pack + human.json + MEMORY.md (skips agent.json, agent.jsonl, snapshot). NOTE: factstack diff/scan-vulns/export-* read agent.json — minimal disables them until the next legacy analyze.')
  .action(async (target: string | undefined, opts: { json?: boolean; progress?: boolean; gitignoreEntry?: boolean; minimal?: boolean }) => {
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

    /* Default `legacy` so the CLI's own downstream commands (diff,
       scan-vulns, export-skills/diagram, ci-report) — which read
       .facts/agent.json back — keep working. `--minimal` is an explicit
       opt-in to the lean set. In minimal, the snapshot is also dropped
       (the orchestrator forces it off), so we don't pass writeSnapshot. */
    const minimal = opts.minimal ?? false;
    const written = await writeArtifacts({
      root,
      agent: result.agent,
      human: result.human,
      profile: minimal ? 'minimal' : 'legacy',
      addGitignoreEntry: opts.gitignoreEntry ?? true,
      ...(minimal ? {} : { writeSnapshot: true }),
      memoryBody: buildMemory(result.agent, result.human),
    });

    const elapsed = performance.now() - t0;

    /* v0.3.4 — append a self-calibrate event to .facts/learnings.jsonl
       so the log starts accumulating from the very first analyze run.
       Best-effort; never fail an analyze just because we couldn't write
       a calibration row. */
    try {
      const ev = selfCalibrateEvent({
        fileCount: result.agent.stats.fileCount,
        totalLoc: result.agent.stats.loc,
        totalTokens: result.agent.stats.totalTokenCost,
        riskCount: result.agent.risks.length,
        durationMs: Math.round(elapsed),
      });
      const factsDir = path.join(root, '.facts');
      const fsmod = await import('node:fs');
      if (!fsmod.existsSync(factsDir)) fsmod.mkdirSync(factsDir, { recursive: true });
      fsmod.appendFileSync(path.join(factsDir, 'learnings.jsonl'), formatLearningEvent(ev), 'utf8');
    } catch {
      // Quiet — calibration is not load-bearing.
    }

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
      written.agentPath ? `  ${kleur.green('✓')} ${relativize(written.agentPath, root)}` : '',
      `  ${kleur.green('✓')} ${relativize(written.humanPath, root)}`,
      `  ${kleur.green('✓')} ${relativize(written.packPath, root)}`,
      written.jsonlPath ? `  ${kleur.green('✓')} ${relativize(written.jsonlPath, root)}` : '',
      written.memoryPath ? `  ${kleur.green('✓')} ${relativize(written.memoryPath, root)}` : '',
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
      if (req.method === 'POST' && url.pathname === '/api/setup-agents') {
        // "Set up FACTS for agents" (ft-1, Layer 3): install/refresh the
        // per-project skill files (Claude SKILL.md, .cursorrules, AGENTS.md,
        // .github/copilot-instructions.md) so AI coding agents read the FACTS
        // pack instead of re-scanning. Renders from the on-disk artifact
        // (kept fresh by reanalyze/watch), reusing the same buildSkillsTo path
        // as `factstack export-skills`.
        void (async () => {
          try {
            const a = loadAndValidate<AgentArtifact>(agentPath, 'agent');
            const h = loadAndValidate<HumanArtifact>(humanPath, 'human');
            const writer = new NodeFileWriter(root, '');
            const result = await buildSkillsTo(writer, a, h);
            // ft-1 Layer 2: install the PostToolUse freshness hook into
            // .claude/settings.local.json so the pack re-renders after every
            // agent edit. Non-fatal — the skills still install if this fails.
            let hookInstalled = false;
            try {
              installFreshnessHook(root);
              hookInstalled = true;
            } catch {
              hookInstalled = false;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              formats: result.formats,
              files: Object.keys(result.files),
              bytesWritten: result.bytesWritten,
              hookInstalled,
            }));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
        })();
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
  .command('scan-vulns [target]')
  .description('Query OSV.dev for CVEs in dependencyManifests + persist findings into <target>/.facts/agent.json')
  .option('--prod-only', 'Skip devDependencies (default: scan everything that ships)')
  .option('--no-cache', 'Bypass any local cache and force fresh OSV queries')
  .option('--json', 'Emit machine-readable JSON to stdout instead of a TTY summary')
  .action(async (target: string | undefined, opts: { prodOnly?: boolean; cache: boolean; json?: boolean }) => {
    const root = path.resolve(target ?? '.');
    const agentPath = path.join(root, '.facts', 'agent.json');
    const humanPath = path.join(root, '.facts', 'human.json');

    /* Pre-flight: agent.json must exist + be valid. We deliberately
       do NOT auto-analyze here (unlike `ui` which does it) — scan-vulns
       is the network-touching step, and we want the user's "analyze
       happened" decision to be explicit. */
    if (!existsSync(agentPath)) {
      process.stderr.write(kleur.red('factstack scan-vulns: ') + 'no .facts/agent.json found.\n');
      process.stderr.write(kleur.dim('  run `factstack analyze .` first; then re-run scan-vulns.\n'));
      process.exit(1);
    }

    let agent: AgentArtifact;
    let human: HumanArtifact;
    try {
      agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
      human = loadAndValidate<HumanArtifact>(humanPath, 'human');
    } catch (err) {
      process.stderr.write(kleur.red('factstack scan-vulns: ') + (err instanceof Error ? err.message : String(err)) + '\n');
      process.exit(1);
    }

    /* Build the OSV query list. flattenManifests dedupes (ecosystem,
       name, version) across the whole project so a dep declared in 8
       workspace packages still makes one OSV query. */
    const flat = flattenManifests(agent.dependencyManifests);
    /* normalizeNpmVersion drops non-registry protocols (workspace:,
       file:, git+, etc.) — those can't be CVE-checked at OSV. We log
       the skipped count so the user knows what we couldn't scan. */
    const queries: OsvQuery[] = [];
    let skippedNonRegistry = 0;
    for (const entry of flat) {
      if (opts.prodOnly) {
        /* --prod-only filtering would require us to know which manifest's
           dep map each entry came from. flattenManifests collapses dev +
           runtime — for prod-only we'd need a richer flatten. MVP: emit
           a warning, scan everything. */
      }
      const concrete = entry.ecosystem === 'npm' ? normalizeNpmVersion(entry.version) : entry.version;
      if (!concrete) {
        skippedNonRegistry++;
        continue;
      }
      queries.push({
        ecosystem: entry.ecosystem,
        name: entry.name,
        version: concrete,
        manifestPath: entry.manifestPaths[0] ?? '',
      });
    }

    if (opts.prodOnly) {
      process.stderr.write(kleur.yellow('  --prod-only: not yet implemented; scanning all deps.\n'));
    }

    if (queries.length === 0) {
      process.stderr.write(kleur.bold().green('FACTS') + kleur.dim(' · scan-vulns: ') + '0 queriable deps (try `factstack analyze` first?)\n');
      if (skippedNonRegistry > 0) {
        process.stderr.write(kleur.dim(`  ${skippedNonRegistry} non-registry deps (workspace:/file:/git:) skipped\n`));
      }
      return;
    }

    process.stderr.write(
      kleur.bold().green('FACTS') +
      kleur.dim(' · scan-vulns: querying ') +
      kleur.cyan(String(queries.length)) +
      kleur.dim(` dep${queries.length === 1 ? '' : 's'} against OSV.dev…\n`),
    );

    const t0 = performance.now();
    let results;
    try {
      /* MVP cache: noopCache. A future filesystem cache at
         .facts/cache/osv/ would speed up repeated CI runs, but the
         OSV API is generous + a single run is the common case. */
      results = await queryOsvBatch(queries, {
        cache: opts.cache === false ? noopCache : noopCache,
      });
    } catch (err) {
      process.stderr.write(kleur.red('factstack scan-vulns: ') + (err instanceof Error ? err.message : String(err)) + '\n');
      process.stderr.write(kleur.dim('  network error? OSV.dev unreachable? Re-run later.\n'));
      process.exit(1);
    }
    const elapsedMs = performance.now() - t0;

    /* Convert OSV's raw shape into the canonical Vulnerability[] the
       artifact carries. Filters out empty results (clean packages). */
    const vulnerabilities: Vulnerability[] = osvResultsToVulnerabilities(results);

    /* Persist back to agent.json. We rewrite the whole artifact via
       writeArtifacts so the .pack + .jsonl companions also refresh
       (they're regenerated from the same in-memory artifact every
       write, so stale companion files would lie about the new vulns). */
    const nextAgent: AgentArtifact = { ...agent, vulnerabilities };
    await writeArtifacts({
      root,
      agent: nextAgent,
      human,
      addGitignoreEntry: false,
      memoryBody: buildMemory(nextAgent, human),
    });

    /* Explicit shape (not Record<string, number>) so noUncheckedIndexedAccess
       can prove each key exists at read time. */
    const counts: { critical: number; high: number; medium: number; low: number; unknown: number } = {
      critical: 0, high: 0, medium: 0, low: 0, unknown: 0,
    };
    for (const v of vulnerabilities) counts[v.severity] = counts[v.severity] + 1;
    const totalVulnerable = new Set(vulnerabilities.map((v) => `${v.ecosystem}|${v.package}@${v.installedVersion}`)).size;

    if (opts.json) {
      process.stdout.write(JSON.stringify({
        scanned: queries.length,
        skippedNonRegistry,
        vulnerablePackages: totalVulnerable,
        findings: vulnerabilities.length,
        counts,
        elapsedMs: Math.round(elapsedMs),
        vulnerabilities,
      }, null, 2) + '\n');
      return;
    }

    /* TTY summary — clear-eyed numbers + a one-line headline. */
    const lines: string[] = [];
    lines.push(
      kleur.bold().green('FACTS') +
      kleur.dim(` · scan-vulns: ${queries.length} scanned, ${totalVulnerable} vulnerable, ${vulnerabilities.length} ${vulnerabilities.length === 1 ? 'finding' : 'findings'}`) +
      kleur.dim(` · ${Math.round(elapsedMs)}ms`),
    );
    if (vulnerabilities.length === 0) {
      lines.push(kleur.green('  ✓ no known vulnerabilities at queried versions'));
    } else {
      const sevParts: string[] = [];
      if (counts.critical > 0) sevParts.push(kleur.red(`${counts.critical} critical`));
      if (counts.high > 0)     sevParts.push(kleur.yellow(`${counts.high} high`));
      if (counts.medium > 0)   sevParts.push(kleur.cyan(`${counts.medium} medium`));
      if (counts.low > 0)      sevParts.push(kleur.dim(`${counts.low} low`));
      if (counts.unknown > 0)  sevParts.push(kleur.dim(`${counts.unknown} unknown`));
      lines.push('  ' + sevParts.join(kleur.dim(' · ')));
      lines.push(kleur.dim('  written to .facts/agent.json — see the Vulnerabilities tab or `factstack query vulnerabilities`'));
    }
    if (skippedNonRegistry > 0) {
      lines.push(kleur.dim(`  ${skippedNonRegistry} non-registry deps skipped (workspace:/file:/git: protocols)`));
    }
    process.stderr.write(lines.join('\n') + '\n');
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

    let from: DiffEndpoint | null;
    let to:   DiffEndpoint | null;

    if (snapA && snapB) {
      // Two-arg: explicit snapshots.
      from = resolveDiffEndpointArg(snapA, snapDir);
      to   = resolveDiffEndpointArg(snapB, snapDir);
    } else if (snapA && !snapB) {
      // One-arg: named snapshot vs current agent.json.
      from = resolveDiffEndpointArg(snapA, snapDir);
      to   = loadDiffEndpoint(path.join(factsDir, 'agent.json'));
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
            return resolveDiffEndpointArg(pick, snapDir);
          })()
        : null;
      to = loadDiffEndpoint(path.join(factsDir, 'agent.json'));
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
  .command('review [base] [head]')
  .description('Change Verdict: fuse diff + blast radius + structural deltas into one PR-ready risk verdict (Markdown or JSON).')
  .option('--json', 'Emit the verdict as JSON instead of Markdown')
  .option('--fail-on <severity>', 'Exit non-zero when verdict severity is >= this (low|medium|high|critical)')
  .option('-r, --root <path>', 'Project root (default cwd)', '.')
  .action(async (baseArg: string | undefined, headArg: string | undefined, opts: { json?: boolean; failOn?: string; root: string }) => {
    if (opts.json === undefined && program.opts().json) opts.json = true;
    const root = path.resolve(opts.root);
    const factsDir = path.join(root, '.facts');
    const snapDir = path.join(factsDir, 'snapshots');

    let from: DiffEndpoint | null;
    let to: DiffEndpoint | null;
    if (baseArg && headArg) {
      from = resolveDiffEndpointArg(baseArg, snapDir);
      to = resolveDiffEndpointArg(headArg, snapDir);
    } else if (baseArg) {
      from = resolveDiffEndpointArg(baseArg, snapDir);
      to = loadDiffEndpoint(path.join(factsDir, 'agent.json'));
    } else {
      // Zero-arg: PREVIOUS snapshot vs current agent.json (same rationale
      // as `diff` — the most recent snapshot was written by this analyze
      // run, so pick the second-to-last to surface real change).
      from = existsSync(snapDir)
        ? (() => {
            const files = statSync(snapDir).isDirectory() ? readdirSnapshotList(snapDir) : [];
            if (!files.length) return null;
            const pick = files[files.length - 2] ?? files[files.length - 1]!;
            return resolveDiffEndpointArg(pick, snapDir);
          })()
        : null;
      to = loadDiffEndpoint(path.join(factsDir, 'agent.json'));
    }

    if (!from || !to) {
      process.stderr.write(kleur.red('factstack review: ') + 'need two analyzable endpoints.\n');
      if (!to) process.stderr.write(kleur.dim('  run factstack analyze to produce .facts/agent.json\n'));
      process.exit(1);
    }

    const verdict = buildChangeVerdict(from.artifact, to.artifact);

    if (opts.json) process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
    else process.stdout.write(renderVerdictMarkdown(verdict) + '\n');

    if (opts.failOn) {
      const RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
      const threshold = RANK[opts.failOn];
      if (threshold === undefined) {
        process.stderr.write(kleur.red('factstack review: ') + `invalid --fail-on "${opts.failOn}" (use low|medium|high|critical)\n`);
        process.exit(2);
      }
      if (RANK[verdict.severity]! >= threshold) {
        process.stderr.write(kleur.yellow('\nfactstack review: ') + `verdict severity "${verdict.severity}" >= --fail-on "${opts.failOn}"\n`);
        process.exit(1);
      }
    }
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
  .command('export-skills [target]')
  .description('Emit project context as AI-agent skill files (Claude SKILL.md + Cursor .cursorrules + GitHub Copilot copilot-instructions.md)')
  .option('--format <ids>', `Comma-separated subset of formats to emit (default: all). Available: ${ALL_FORMATS.join(', ')}`)
  .option('--json', 'Emit machine-readable JSON to stdout instead of a TTY summary')
  .action(async (target: string | undefined, opts: { format?: string; json?: boolean }) => {
    if (opts.json === undefined && program.opts().json) opts.json = true;
    const root = path.resolve(target ?? '.');
    const agentPath = path.join(root, '.facts', 'agent.json');
    const humanPath = path.join(root, '.facts', 'human.json');

    /* Pre-flight: artifact must exist. Unlike `ui` we do NOT
       auto-analyze here — `export-skills` writes user-visible files at
       the project root, and we want the user's "analyze happened"
       decision to be explicit. */
    if (!existsSync(agentPath) || !existsSync(humanPath)) {
      process.stderr.write(kleur.red('factstack export-skills: ') + 'no .facts/agent.json or human.json found.\n');
      process.stderr.write(kleur.dim('  run `factstack analyze .` first; then re-run export-skills.\n'));
      process.exit(1);
    }

    let agent: AgentArtifact;
    let human: HumanArtifact;
    try {
      agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
      human = loadAndValidate<HumanArtifact>(humanPath, 'human');
    } catch (err) {
      process.stderr.write(kleur.red('factstack export-skills: ') + (err instanceof Error ? err.message : String(err)) + '\n');
      process.exit(1);
    }

    /* Parse --format. Filter against ALL_FORMATS so a typo doesn't
       silently emit nothing (the orchestrator silently drops unknowns
       by design; we surface the typo here at the CLI layer where the
       user can see it). */
    let formats: SkillFormatId[] | undefined;
    if (opts.format) {
      const requested = opts.format.split(',').map((s) => s.trim()).filter(Boolean);
      const known = new Set<string>(ALL_FORMATS);
      const unknown = requested.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        process.stderr.write(
          kleur.red('factstack export-skills: ') +
            `unknown format${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}\n`,
        );
        process.stderr.write(kleur.dim(`  available: ${ALL_FORMATS.join(', ')}\n`));
        process.exit(1);
      }
      formats = requested as SkillFormatId[];
    }

    /* Skills land at the PROJECT ROOT, not under .facts/ — `.cursorrules`
       lives next to package.json, `.claude/skills/...` is what Claude
       Code scans, `.github/copilot-instructions.md` is GitHub's
       convention. The empty-subdir constructor variant gives us that. */
    const writer = new NodeFileWriter(root, '');
    const result = await buildSkillsTo(writer, agent, human, formats);

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            formats: result.formats,
            files: Object.keys(result.files),
            bytesWritten: result.bytesWritten,
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }

    const lines: string[] = [
      '',
      kleur.bold().green('FACTS') + kleur.dim(' · export-skills'),
      kleur.dim('  ─────────────────'),
    ];
    for (const filePath of Object.keys(result.files).sort()) {
      lines.push(`  ${kleur.green('✓')} ${filePath}`);
    }
    lines.push('');
    lines.push(
      kleur.dim(
        `  ${result.formats.length} format${result.formats.length === 1 ? '' : 's'} · ` +
          `${Object.keys(result.files).length} file${Object.keys(result.files).length === 1 ? '' : 's'} · ` +
          `${formatBytes(result.bytesWritten)} written`,
      ),
    );
    lines.push('');
    process.stderr.write(lines.join('\n') + '\n');
  });

program
  .command('export-diagram [target]')
  .description('Emit a Mermaid flowchart of the project graph (package / hub / focal views)')
  .option('--view <view>', 'Diagram view: package | hub | focal (default: package)', 'package')
  .option('--focus <path>', 'Project-relative file path; required when --view=focal')
  .option('--depth <n>', 'Max BFS depth for focal view (default: 2)', '2')
  .option('--max-nodes <n>', 'Hard cap on node count across all views (default: 30)', '30')
  .option('-o, --out <path>', 'Write the diagram to <path> instead of stdout. Wraps in a ```mermaid block if the file ends in .md.')
  .option('--no-wrap', 'When writing a .md file, skip the ```mermaid wrapper (emit bare flowchart source)')
  .option('--json', 'Emit a JSON envelope with metadata + the diagram source')
  .action(async (
    target: string | undefined,
    opts: {
      view: string;
      focus?: string;
      depth: string;
      maxNodes: string;
      out?: string;
      wrap: boolean;
      json?: boolean;
    },
  ) => {
    if (opts.json === undefined && program.opts().json) opts.json = true;
    const root = path.resolve(target ?? '.');
    const agentPath = path.join(root, '.facts', 'agent.json');

    if (!existsSync(agentPath)) {
      process.stderr.write(kleur.red('factstack export-diagram: ') + 'no .facts/agent.json found.\n');
      process.stderr.write(kleur.dim('  run `factstack analyze .` first.\n'));
      process.exit(1);
    }

    let agent: AgentArtifact;
    try {
      agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
    } catch (err) {
      process.stderr.write(kleur.red('factstack export-diagram: ') + (err instanceof Error ? err.message : String(err)) + '\n');
      process.exit(1);
    }

    /* Validate --view against the union before passing to buildDiagram.
       commander gives us a string; the renderer wants a literal type. */
    if (opts.view !== 'package' && opts.view !== 'hub' && opts.view !== 'focal') {
      process.stderr.write(
        kleur.red('factstack export-diagram: ') +
          `unknown --view "${opts.view}". Expected: package, hub, focal\n`,
      );
      process.exit(1);
    }

    /* Focal requires --focus. Surface this as a clear error from the
       CLI rather than letting the renderer throw — the renderer's
       throw is the second line of defense; this is the user-facing one. */
    if (opts.view === 'focal' && !opts.focus) {
      process.stderr.write(
        kleur.red('factstack export-diagram: ') +
          '--view=focal requires --focus <path>.\n',
      );
      process.stderr.write(
        kleur.dim('  example: factstack export-diagram --view focal --focus packages/core/src/diff.ts\n'),
      );
      process.exit(1);
    }

    const view = opts.view as DiagramView;
    const depth = parseIntInRange(opts.depth, 2, 1, 5);
    const maxNodes = parseIntInRange(opts.maxNodes, 30, 2, 80);

    const mermaidSource = buildDiagram(agent, {
      view,
      ...(opts.focus ? { focus: opts.focus } : {}),
      depth,
      maxNodes,
    });

    /* JSON mode: emit an envelope with metadata + the source so
       downstream tools (e.g. a future MCP tool) can compose against
       a known shape. */
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            view,
            ...(opts.focus ? { focus: opts.focus } : {}),
            depth,
            maxNodes,
            mermaid: mermaidSource,
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }

    /* --out file write OR stdout pipe. For .md files we wrap in a
       ```mermaid block by default so the file is paste-ready into any
       markdown surface; --no-wrap opts out for users targeting a
       Mermaid Live Editor or a custom embed. */
    const outputBody = opts.out && opts.out.endsWith('.md') && opts.wrap !== false
      ? '```mermaid\n' + mermaidSource + '```\n'
      : mermaidSource;

    if (opts.out) {
      const outPath = path.resolve(opts.out);
      mkdirSync(path.dirname(outPath), { recursive: true });
      writeFileSync(outPath, outputBody, 'utf8');
      process.stderr.write(
        kleur.bold().green('FACTS') +
          kleur.dim(' · export-diagram ') +
          kleur.cyan(view) +
          kleur.dim(' → ') +
          kleur.cyan(relativize(outPath, process.cwd())) +
          kleur.dim(` (${formatBytes(outputBody.length)})`) +
          '\n',
      );
      return;
    }

    /* Default: pipe to stdout so consumers can do
       `factstack export-diagram > out.mmd` or pipe into pbcopy/xclip. */
    process.stdout.write(outputBody);
  });

program
  .command('ci-report [target]')
  .description('Emit a markdown diff report (head vs base) suitable for posting as a PR comment or GitHub Actions step summary')
  .requiredOption('--base <path>', 'Base endpoint to compare against (snapshot path, snapshot stamp, or agent.json)')
  .option('--head <path>', 'Head endpoint (default: <target>/.facts/agent.json)')
  .option('--fail-on-shift <n>', 'Exit non-zero if vulns.severityShift >= n (use in CI to gate merges; default: no gate)')
  .option('--with-diagram', 'Embed a Mermaid architecture diagram between vuln + files sections (auto-picks package or focal view based on the diff)')
  .option('--json', 'Emit the underlying DiffArtifact as JSON on stdout instead of the markdown report')
  .action(async (target: string | undefined, opts: { base: string; head?: string; failOnShift?: string; withDiagram?: boolean; json?: boolean }) => {
    if (opts.json === undefined && program.opts().json) opts.json = true;
    const root = path.resolve(target ?? '.');
    const factsDir = path.join(root, '.facts');
    const snapDir = path.join(factsDir, 'snapshots');

    const from = resolveDiffEndpointArg(opts.base, snapDir);
    const headPath = opts.head ? path.resolve(opts.head) : path.join(factsDir, 'agent.json');
    const to = loadDiffEndpoint(headPath);

    if (!from) {
      process.stderr.write(kleur.red('factstack ci-report: ') + `base "${opts.base}" not found.\n`);
      process.stderr.write(kleur.dim('  pass a snapshot path under .facts/snapshots/ or a full agent.json path.\n'));
      process.exit(1);
    }
    if (!to) {
      process.stderr.write(kleur.red('factstack ci-report: ') + `head "${headPath}" not found.\n`);
      process.stderr.write(kleur.dim('  run `factstack analyze .` to produce .facts/agent.json, or pass --head.\n'));
      process.exit(1);
    }

    const diff = diffArtifacts(from, to);

    if (opts.json) {
      process.stdout.write(JSON.stringify(diff, null, 2) + '\n');
    } else {
      /* Default behavior: markdown on stdout so it pipes cleanly into
         `gh pr comment --body-file -` and similar. TTY chrome goes to
         stderr (preserved by all the other commands too).

         --with-diagram: auto-pick a view based on the diff shape.
         The rule:
           - exactly 1 changed file → focal view rooted on it
             (most useful: "what depends on the thing I changed")
           - 2-3 files in 1 package → focal view rooted on the
             most-changed file (largest |tokenDelta|)
           - otherwise → package view (broad changes need overview)

         The auto-pick is intentionally simple so PR reviewers can
         predict when the diagram will be focal vs package. See
         `pickAutoView` below. */
      const diagram = opts.withDiagram ? buildAutoDiagram(to.artifact, diff) : undefined;
      process.stdout.write(renderCiReport(diff, { ...(diagram ? { diagram } : {}) }));
    }

    /* --fail-on-shift: optional merge gate. Compares against the
       severity-shift score (not raw count) because shift captures
       "got meaningfully worse" — see comments in packages/core/src/diff.ts.
       A value of `1` would gate on any net worsening; `4` would gate
       only on a new critical-equivalent. */
    if (opts.failOnShift !== undefined) {
      const threshold = parseIntInRange(opts.failOnShift, NaN, -1000, 1000);
      if (!Number.isFinite(threshold)) {
        process.stderr.write(kleur.red('factstack ci-report: ') + `--fail-on-shift must be a number (got "${opts.failOnShift}")\n`);
        process.exit(2);
      }
      if (diff.vulns.severityShift >= threshold) {
        const sign = diff.vulns.severityShift >= 0 ? '+' : '';
        process.stderr.write(
          kleur.red('factstack ci-report: ') +
            `severity shift ${sign}${diff.vulns.severityShift} >= ${threshold} — gating merge.\n`,
        );
        process.exit(1);
      }
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

/**
 * Load an `AgentArtifact`-shaped `DiffEndpoint` from a path on disk.
 * Used by both `diff` and `ci-report`.
 *
 * Handles two file shapes:
 *   1. Full `.facts/agent.json` — has `files[]`. Loaded as-is.
 *   2. Compact `.facts/snapshots/<ISO>.json` — stats-only rollup, no
 *      `files[]`. Synthesized into a minimal AgentArtifact with
 *      empty `files`/`graph`/`vulnerabilities` arrays so the diff
 *      function's headline-metric paths work; per-file diffs get
 *      `incomplete: true`. Top-level rollup counts (todos, broken,
 *      stale, secrets) ride along as `overrides` so the diff doesn't
 *      report "0 → current" for them.
 *
 * Returns `null` if the path doesn't exist or doesn't parse — callers
 * (`diff`, `ci-report`) surface that as their own error message.
 *
 * Extracted from the inline closures in `diff` and `ci-report` so the
 * two verbs share one source of truth for endpoint loading.
 */
/**
 * Resolve a user-supplied diff-endpoint argument by trying a small
 * candidate list:
 *   1. Raw arg (works if user gave a full or cwd-relative path).
 *   2. `path.resolve(arg)` (absolutize cwd-relative).
 *   3. `<snapDir>/<arg>` (bare snapshot stamp).
 *   4. `<snapDir>/<arg>.json` (snapshot stamp without extension).
 *
 * Returns the first successfully-loaded endpoint, or null.
 *
 * Extracted because `diff` and `ci-report` both apply the same search
 * priority — the only per-call variable is `snapDir`.
 */
function resolveDiffEndpointArg(arg: string, snapDir: string): DiffEndpoint | null {
  const candidates = [
    arg,
    path.resolve(arg),
    path.join(snapDir, arg),
    path.join(snapDir, arg + '.json'),
  ];
  for (const c of candidates) {
    const loaded = loadDiffEndpoint(c);
    if (loaded) return loaded;
  }
  return null;
}

/**
 * Decide which diagram view to embed in `ci-report` given the diff
 * shape, then build the Mermaid source for it. Returns `undefined`
 * if the head artifact has no graph data (can happen with snapshot
 * endpoints) — the emitter handles that by omitting the section.
 *
 * Rule:
 *   - exactly 1 changed file → focal view rooted on that file.
 *   - 2-3 files all in the same package → focal on the most-changed
 *     (largest |tokenDelta|). Picks a single anchor that reviewers
 *     can mentally tie to the change set.
 *   - 0 file changes (incomplete diff or zero-delta) → package view.
 *   - otherwise (broad changes) → package view.
 *
 * The package view is the safe default: it always renders and never
 * "lies" about what changed. Focal is the more useful view when it
 * fits cleanly.
 */
function buildAutoDiagram(
  headAgent: AgentArtifact,
  diff: DiffArtifact,
): { source: string; view: 'package' | 'focal'; focus?: string } | undefined {
  /* Bail when the head artifact has no graph — synthetic snapshot
     endpoints in loadDiffEndpoint have an empty edges array. The
     diagram would render an empty placeholder; better to omit. */
  if (!headAgent.graph || headAgent.graph.edges.length === 0) return undefined;

  /* When the file-level diff is incomplete (snapshot rollup endpoint),
     we can't see individual files — fall straight to package view. */
  if (diff.files.incomplete) {
    return {
      source: buildDiagram(headAgent, { view: 'package' }),
      view: 'package',
    };
  }

  const changed = [
    ...diff.files.added.map((path) => ({ path, tokenDelta: 0 })),
    ...diff.files.removed.map((path) => ({ path, tokenDelta: 0 })),
    ...diff.files.changed.map((c) => ({ path: c.path, tokenDelta: c.tokenDelta })),
  ];

  /* 1 changed file: focal view rooted on it. */
  if (changed.length === 1) {
    const focus = changed[0]!.path;
    return {
      source: buildDiagram(headAgent, { view: 'focal', focus }),
      view: 'focal',
      focus,
    };
  }

  /* 2-3 files all in the same package: focal on most-changed.
     Compares package roots (e.g. `apps/cli/...` vs `packages/spec/...`)
     using the first two path segments — same heuristic the diagram's
     own package classifier uses, kept local to avoid cross-package
     re-export gymnastics for one private helper. */
  if (changed.length >= 2 && changed.length <= 3) {
    const pkgs = new Set(changed.map((c) => packageRoot(c.path)));
    if (pkgs.size === 1 && !pkgs.has(null)) {
      const anchor = changed
        .slice()
        .sort((a, b) => Math.abs(b.tokenDelta) - Math.abs(a.tokenDelta))[0]!;
      return {
        source: buildDiagram(headAgent, { view: 'focal', focus: anchor.path }),
        view: 'focal',
        focus: anchor.path,
      };
    }
  }

  /* Broad changes: package view. */
  return {
    source: buildDiagram(headAgent, { view: 'package' }),
    view: 'package',
  };
}

/* Local-only mirror of @factstack/core's classifyPath. Inlined here
 * because exposing it through buildDiagram's surface area for one
 * caller wasn't worth the API contract. */
function packageRoot(p: string): string | null {
  const norm = p.replace(/\\/g, '/');
  const match = norm.match(/^(packages|apps)\/([^/]+)/);
  if (match) return `${match[1]}/${match[2]}`;
  if (norm.startsWith('docs/')) return 'docs';
  if (norm.startsWith('legacy/')) return 'legacy';
  return null;
}

function loadDiffEndpoint(p: string): DiffEndpoint | null {
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
      docs: [],
      /* Clamp risk-count synthesis: snapshots are on-disk data we
         don't fully trust (corrupted file, mis-written by an older
         FACTS, etc.). `new Array(1e9).fill(...)` would OOM the CLI
         instantly; cap at a sane upper bound. The cap (10_000) is
         larger than any realistic risk count + small enough to be
         safe to allocate. Negative values would throw RangeError so
         the Math.max(0, …) is load-bearing too. */
      risks: new Array(Math.max(0, Math.min(raw.risks ?? 0, 10_000))).fill(null).map(() => ({ severity: 'info' as const, category: 'stale' as const, rule: 'snapshot-placeholder', message: '' })),
      stats: {
        loc: raw.stats?.loc ?? 0,
        fileCount: raw.stats?.fileCount ?? 0,
        packageCount: 0,
        totalTokenCost: raw.stats?.totalTokenCost ?? 0,
      },
      /* v0.6 — both new fields default to []. Snapshots don't carry
         dep/vuln data; the diff treats them as "unknown rather than
         zero." Future snapshot versions may include vuln counts in
         the rollup. */
      dependencyManifests: [],
      vulnerabilities: [],
    };
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
}

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
