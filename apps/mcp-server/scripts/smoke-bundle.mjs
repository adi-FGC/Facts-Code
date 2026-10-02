#!/usr/bin/env node
/**
 * Prove an assembled publish folder works on its own. Copies it to a fresh
 * temp dir (so no workspace package can resolve), then with plain `node`:
 *
 *   1. `--version` prints the package.json version
 *   2. `--help` prints the usage
 *   3. a real MCP session over stdio against a small fixture project:
 *      initialize → tools/list (17) → analyze → resources/read facts://project
 *      → query_graph callers
 *   4. with --pack: `npm pack --dry-run` lists exactly the expected files
 *
 *   node scripts/smoke-bundle.mjs [publishDir] [--pack] [--keep]
 *
 * The temp dir is deleted afterwards (pass or fail) unless --keep, which
 * leaves it for debugging and prints where it is. The last line printed is
 * `smoke ok`; no output means it did not run.
 *
 * Signed out (empty FACTS_HOME) and offline: nothing here touches the network.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const REQUEST_TIMEOUT_MS = 60_000;

function check(ok, what) {
  if (!ok) throw new Error(`smoke failed: ${what}`);
}

/** A tiny project: b.ts is imported by a.ts, so `callers b.ts` is 1. */
function fixture(base) {
  const root = path.join(base, 'fixture');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"name":"smoke-fixture","version":"1.0.0"}\n');
  writeFileSync(path.join(root, 'src', 'b.ts'), 'export function b() {\n  return 1;\n}\n');
  writeFileSync(
    path.join(root, 'src', 'a.ts'),
    "import { b } from './b';\nexport const a = () => b();\n",
  );
  return root;
}

/** Newline-delimited JSON-RPC over the child's stdio (the MCP stdio framing). */
function rpcSession(child) {
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!p) continue;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  });
  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  return {
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method}: no answer in ${REQUEST_TIMEOUT_MS} ms`));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    },
    notify: (method, params = {}) => send({ method, params }),
  };
}

/** npm's own CLI next to this Node, run with node (no shell, no npm.cmd). */
function npmCli() {
  const dir = path.dirname(process.execPath);
  for (const p of [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Resolves once the child has exited (at once if it already has). */
function exited(child) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', resolve));
}

/**
 * Run the smoke. Returns what it saw; `tempDir` is where it ran (made under
 * `tempRoot`), deleted by then, pass or fail, unless `keep` (each run copies
 * the ~1.8 MB bundle plus a fixture).
 */
export async function smokeBundle({
  publishDir,
  pack = false,
  keep = false,
  tempRoot = tmpdir(),
  log = console.log,
}) {
  const manifest = JSON.parse(readFileSync(path.join(publishDir, 'package.json'), 'utf8'));
  const base = mkdtempSync(path.join(tempRoot, 'factstack-mcp-smoke-'));
  try {
    return await smokeIn(base, { publishDir, manifest, pack, log });
  } finally {
    if (keep) log(`kept       ${base}`);
    // The server child has exited by now; retries cover Windows' lagging handle release.
    else rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function smokeIn(base, { publishDir, manifest, pack, log }) {
  const pkgDir = path.join(base, 'pkg');
  cpSync(publishDir, pkgDir, { recursive: true });
  const bin = path.join(pkgDir, manifest.bin[manifest.name]);
  const env = {
    ...process.env,
    FACTS_HOME: path.join(base, 'home'), // no auth.json → signed out, no network
    FACTS_ROOT: '',
    NODE_PATH: '',
  };
  const run = (...args) =>
    spawnSync(process.execPath, [bin, ...args], { cwd: base, env, encoding: 'utf8' });
  const report = { tempDir: base };

  const version = run('--version');
  check(version.status === 0, `--version exited ${version.status}: ${version.stderr}`);
  check(version.stdout.trim() === manifest.version, `--version printed ${version.stdout.trim()}`);
  report.version = version.stdout.trim();
  log(`--version  ${report.version}`);

  const help = run('--help');
  check(help.status === 0 && /Usage:/.test(help.stdout), `--help: ${help.stderr}`);
  report.helpFirstLine = help.stdout.split('\n')[0];
  log(`--help     ${report.helpFirstLine}`);

  const root = fixture(base);
  const child = spawn(process.execPath, [bin, '--root', root], { cwd: base, env });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => (stderr += d));
  try {
    const rpc = rpcSession(child);
    const init = await rpc.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'factstack-mcp-smoke', version: '0' },
    });
    check(
      init.serverInfo?.name === 'factstack' && init.serverInfo.version === manifest.version,
      `serverInfo ${JSON.stringify(init.serverInfo)}`,
    );
    rpc.notify('notifications/initialized');
    const tools = await rpc.request('tools/list');
    check(tools.tools.length === 17, `tools/list returned ${tools.tools.length} tools`);
    const text = (r) => r.content[0].text;
    const analyzed = await rpc.request('tools/call', { name: 'analyze', arguments: {} });
    check(!analyzed.isError, `analyze: ${text(analyzed)}`);
    const stats = JSON.parse(text(analyzed)).stats;
    check(stats.fileCount >= 3, `analyze saw ${stats.fileCount} files`);
    const project = await rpc.request('resources/read', { uri: 'facts://project' });
    check(/"fileCount"/.test(project.contents[0].text), 'facts://project has no stats');
    const callers = await rpc.request('tools/call', {
      name: 'query_graph',
      arguments: { verb: 'callers', path: 'src/b.ts', format: 'json' },
    });
    check(JSON.parse(text(callers)).count === 1, `callers of src/b.ts: ${text(callers)}`);
    check(existsSync(path.join(root, '.facts', 'agent.json')), 'no .facts/agent.json written');
    report.session = { tools: tools.tools.length, files: stats.fileCount, callersOfB: 1 };
    log(
      `stdio      initialize ok, ${tools.tools.length} tools, analyze ${stats.fileCount} files, ` +
        'facts://project ok, callers(src/b.ts) = 1',
    );
  } catch (err) {
    throw new Error(`${err.message}\n--- server stderr ---\n${stderr}`, { cause: err });
  } finally {
    child.stdin.end();
    child.kill();
    await exited(child); // it holds files under `base` open until it is gone
  }

  if (pack) {
    const cli = npmCli();
    const r = cli
      ? spawnSync(process.execPath, [cli, 'pack', '--dry-run', '--json'], {
          cwd: pkgDir,
          encoding: 'utf8',
        })
      : spawnSync('npm pack --dry-run --json', { cwd: pkgDir, encoding: 'utf8', shell: true });
    check(r.status === 0, `npm pack --dry-run exited ${r.status}: ${r.stderr}`);
    const [info] = JSON.parse(r.stdout);
    const files = info.files.map((f) => f.path).sort();
    const want = ['package.json', ...manifest.files].sort();
    check(JSON.stringify(files) === JSON.stringify(want), `npm pack lists ${files.join(', ')}`);
    report.pack = {
      name: info.name,
      version: info.version,
      files,
      unpackedSize: info.unpackedSize,
    };
    log(`npm pack   ${info.name}@${info.version}: ${files.join(', ')} (dry run, nothing written)`);
  }
  return report;
}

/* import.meta.main, not an argv[1] URL compare (see scripts/bundle.mjs). */
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith('--'));
  const { PUBLISH_DIR } = await import('./assemble-publish.mjs');
  await smokeBundle({
    publishDir: dir ? path.resolve(dir) : PUBLISH_DIR,
    pack: argv.includes('--pack'),
    keep: argv.includes('--keep'),
  });
  console.log('smoke ok');
}
