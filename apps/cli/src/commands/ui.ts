/**
 * `factstack ui [target]` (and `watch`, its --watch alias): refresh a stale
 * or missing .facts/, then serve the dashboard from ../ui-server.ts on
 * 127.0.0.1, with the idle auto-shutdown, the optional chokidar watcher and a
 * clean Ctrl-C. The server's routes and guards live in ui-server.ts.
 */
import path from 'node:path';
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import kleur from 'kleur';
import open from 'open';
import chokidar, { type FSWatcher } from 'chokidar';
import { humanToViz, readSnapshots } from '@factstack/emit';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { loadAndValidate } from '../artifacts.js';
import { processIO, type CliIO } from '../io.js';
import { analyzeAndWrite } from '../pipeline.js';
import { addRecent, createUiServer } from '../ui-server.js';
import { readUiTemplate } from '../uiTemplate.js';

export interface UiOptions {
  port: string;
  open: boolean;
  reanalyze?: boolean;
  watch?: boolean;
  idleTimeout?: string;
  staleCheck?: boolean;
}

/**
 * Cheap staleness check (ft-10): is `.facts/agent.json` older than the
 * newest source file? Walks the tree (skipping .facts, node_modules, build
 * outputs, and ALL dotfiles — notably .gitignore, which analyze itself
 * rewrites), returning true on the first source file newer than the
 * artifact. Bounded so it can't hang on a giant tree. Lets `factstack ui`
 * re-emit a fresh artifact instead of serving a stale dashboard.
 */
export function isArtifactStale(root: string, agentPath: string): boolean {
  let artifactMtime: number;
  try {
    artifactMtime = statSync(agentPath).mtimeMs;
  } catch {
    return true; // missing/unreadable artifact → treat as stale
  }
  const IGNORE = new Set([
    '.facts',
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    '.turbo',
    '.cache',
    '.svelte-kit',
    '.output',
    'coverage',
    '.vercel',
    '.netlify',
  ]);
  const stack: string[] = [root];
  let checked = 0;
  const CAP = 20_000; // give up rather than hang on a pathological tree
  while (stack.length > 0) {
    const dir = stack.pop()!;
    // withFileTypes:true → Dirent[]. Annotate explicitly: under newer
    // @types/node `ReturnType<typeof readdirSync>` resolves to the Buffer[]
    // overload, which loses `.name`/`.isDirectory()`.
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // skip dotfiles + dot-dirs (incl. .gitignore)
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE.has(e.name)) stack.push(full);
      } else {
        if (++checked > CAP) return false;
        try {
          if (statSync(full).mtimeMs > artifactMtime) return true;
        } catch {
          /* unreadable file — ignore */
        }
      }
    }
  }
  return false;
}

export async function uiCommand(
  target: string | undefined,
  opts: UiOptions,
  io: CliIO = processIO,
): Promise<void> {
  const root = path.resolve(target ?? '.');
  const factsDir = path.join(root, '.facts');
  const agentPath = path.join(factsDir, 'agent.json');
  const humanPath = path.join(factsDir, 'human.json');

  const stale =
    !opts.reanalyze &&
    opts.staleCheck !== false &&
    existsSync(agentPath) &&
    existsSync(humanPath) &&
    isArtifactStale(root, agentPath);
  if (opts.reanalyze || !existsSync(humanPath) || !existsSync(agentPath) || stale) {
    io.stderr.write(
      kleur.dim(
        !existsSync(humanPath)
          ? '  no existing .facts/ — running analysis first…\n'
          : stale
            ? '  source changed since the last analyze — refreshing artifact…\n'
            : '  re-analyzing before serving…\n',
      ),
    );
    await analyzeAndWrite(root, {}, io);
  }

  let agent: AgentArtifact;
  let human: HumanArtifact;
  try {
    agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
    human = loadAndValidate<HumanArtifact>(humanPath, 'human');
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack ui: ') + (err instanceof Error ? err.message : String(err)) + '\n',
    );
    io.stderr.write(
      kleur.dim(
        '  run `factstack analyze .` to regenerate, or `factstack ui --reanalyze` to re-run now.\n',
      ),
    );
    io.exit(1);
  }
  const viz = humanToViz(agent, human);
  // Overlay the absolute path so the UI's project chip shows the real
  // location instead of the analyzer's relative "." root.
  viz.project.root = root;
  viz.history = await readSnapshots(root);

  // ft-6: remember this project so the picker can offer it as a recent.
  addRecent(root);

  const template = readUiTemplate();

  // Idle auto-shutdown (ft-3): if the server sees no HTTP request and no
  // watcher reanalyze for N minutes, exit so `factstack ui` never lingers
  // as an orphan. Reset from the request handler + every re-analyze (the
  // server's onActivity); `--idle-timeout 0` disables it. `stop()` is
  // declared further down — it's only referenced inside the deferred timer,
  // by which point it exists.
  const idleMinutes = Number(opts.idleTimeout) || 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  function resetIdle(): void {
    if (idleMinutes <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      io.stderr.write(
        kleur.dim(`\n  idle for ${idleMinutes}m with no activity — shutting down.\n`),
      );
      stop();
    }, idleMinutes * 60_000);
    idleTimer.unref();
  }

  const port = Number(opts.port) || 4747;

  const ui = createUiServer({
    root,
    port,
    template,
    viz,
    reanalyze: () => analyzeAndWrite(root, { writeSnapshot: true }, io),
    onActivity: resetIdle,
  });
  const server = ui.server;

  // Friendly error for the common "port in use" case — a stack trace
  // scares users and `node:http` emits EADDRINUSE via the error event
  // rather than rejecting the listen() promise.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      io.stderr.write(kleur.red('factstack ui: ') + `port ${port} is in use.\n`);
      io.stderr.write(kleur.dim(`  try a different port: factstack ui --port ${port + 1}\n`));
      io.exit(1);
    }
    io.stderr.write(kleur.red('factstack ui: ') + err.message + '\n');
    if (process.env.FACTSTACK_DEBUG && err.stack) io.stderr.write(err.stack + '\n');
    io.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    const mode = opts.watch ? ' (watch)' : '';
    io.stderr.write(
      kleur.bold().green('FACTS UI' + mode) + kleur.dim(' · serving ') + kleur.cyan(url) + '\n',
    );
    io.stderr.write(
      kleur.dim('  project: ') + agent.project.name + kleur.dim(' · ') + kleur.dim(root) + '\n',
    );
    io.stderr.write(
      kleur.dim('  press Ctrl-C to stop') +
        (idleMinutes > 0 ? kleur.dim(` · idle shutdown ${idleMinutes}m`) : '') +
        '\n',
    );
    if (opts.open !== false)
      open(url).catch(() => {
        /* ignore */
      });
    resetIdle();
  });

  // Watch mode: chokidar → 500ms debounce → the server's serialized
  // re-analyze chain → SSE push. Excludes `.facts/**` to prevent
  // write→watch→write feedback loops, `node_modules/**` / build outputs to
  // stay under Windows watch-FD limits, and `.git/` for the same reason.
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
        ui.queueWatchReanalyze();
      }, 500);
    });
    io.stderr.write(kleur.dim('  watching source files — edits will re-analyze + push updates\n'));
  }

  // On Ctrl-C, close the watcher, close keep-alive sockets, then close
  // the server. All three are required or the process hangs until the
  // browser tab closes.
  const stop = () => {
    try {
      watcher?.close();
    } catch {
      /* ignore */
    }
    try {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    } catch {
      /* ignore older Node */
    }
    server.close(() => io.exit(0));
    // Hard timeout: if close takes >3s, exit anyway.
    setTimeout(() => io.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
