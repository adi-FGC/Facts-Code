#!/usr/bin/env node
// prototype/scripts/scan.mjs
// One-shot analyzer for the prototype. Scans a directory, respects gitignore,
// emits a JSON shape the prototype renders. Pre-prod stand-in for the real
// @factstack/core pipeline — deliberately simpler (no tree-sitter, no
// better stats than byte count + LOC + extension-to-language).

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const ALWAYS_EXCLUDE = new Set([
  'node_modules', 'dist', 'build', '.next', '.turbo', '.cache',
  '__pycache__', '.venv', '.git', 'vendor', 'target', 'coverage',
  '.pnpm-store', '.vscode', '.idea',
]);

const EXT_LANG = {
  '.ts': { id: 'typescript', label: 'TypeScript', iconColor: '#3178c6', tag: 'TS' },
  '.tsx': { id: 'typescript', label: 'TypeScript', iconColor: '#3178c6', tag: 'TSX' },
  '.js': { id: 'javascript', label: 'JavaScript', iconColor: '#f7df1e', tag: 'JS' },
  '.jsx': { id: 'javascript', label: 'JavaScript', iconColor: '#f7df1e', tag: 'JSX' },
  '.mjs': { id: 'javascript', label: 'JavaScript', iconColor: '#f7df1e', tag: 'MJS' },
  '.cjs': { id: 'javascript', label: 'JavaScript', iconColor: '#f7df1e', tag: 'CJS' },
  '.py': { id: 'python', label: 'Python', iconColor: '#3776ab', tag: 'PY' },
  '.json': { id: 'json', label: 'JSON', iconColor: '#cbd5e1', tag: 'JSON' },
  '.yaml': { id: 'yaml', label: 'YAML', iconColor: '#cb171e', tag: 'YAML' },
  '.yml': { id: 'yaml', label: 'YAML', iconColor: '#cb171e', tag: 'YML' },
  '.toml': { id: 'toml', label: 'TOML', iconColor: '#9c4221', tag: 'TOML' },
  '.md': { id: 'markdown', label: 'Markdown', iconColor: '#60a5fa', tag: 'MD' },
  '.mdx': { id: 'markdown', label: 'Markdown', iconColor: '#60a5fa', tag: 'MDX' },
  '.html': { id: 'html', label: 'HTML', iconColor: '#e34f26', tag: 'HTML' },
  '.css': { id: 'css', label: 'CSS', iconColor: '#1572b6', tag: 'CSS' },
  '.svg': { id: 'svg', label: 'SVG', iconColor: '#ffb13b', tag: 'SVG' },
};

// Files that are definitionally broken/config
const CONFIG_FILES = new Set([
  'package.json', 'tsconfig.json', 'tsconfig.base.json',
  'pnpm-workspace.yaml', 'turbo.json', '.prettierrc.json',
  '.editorconfig', '.gitignore', '.gitattributes', '.nvmrc',
  '.oxlintrc.json', 'eslint.config.mjs',
]);

const DEFAULT_IGNORES = [
  'node_modules', 'dist', 'build', '.next', '.turbo', '.cache',
  '__pycache__', '.venv', '.git', 'vendor', 'target', 'coverage',
  '.pnpm-store', '.vscode', '.idea', '*.log', '.env', '.env.local',
  'playwright-report', 'test-results',
];

function parseGitignore(content) {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function matches(patterns, relPath, isDir) {
  const base = path.basename(relPath);
  for (const p of patterns) {
    if (!p) continue;
    if (p === base || p === relPath) return true;
    if (p.endsWith('/') && isDir && (base === p.slice(0, -1) || relPath.startsWith(p))) return true;
    if (p.startsWith('*.') && base.endsWith(p.slice(1))) return true;
    if (p.includes('*')) {
      const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      if (re.test(base) || re.test(relPath)) return true;
    }
  }
  return false;
}

// Rough token estimator: chars/3.5 works close enough to cl100k for source code.
function estimateTokens(bytes, text) {
  const chars = text.length;
  return Math.max(1, Math.round(chars / 3.5));
}

// Rough gzipped-size estimator: gzip the content.
async function gzipSize(buffer) {
  return new Promise((resolve, reject) => {
    zlib.gzip(buffer, (err, zipped) => {
      if (err) reject(err);
      else resolve(zipped.length);
    });
  });
}

async function walk(root, rel = '', ignorePatterns = []) {
  const abs = path.join(root, rel);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const dirFiles = [];
  const dirChildren = [];

  // Stack-local ignore patterns from this directory's .gitignore
  let localIgnores = [...ignorePatterns];
  const gitignorePath = path.join(abs, '.gitignore');
  try {
    const content = await fs.readFile(gitignorePath, 'utf8');
    localIgnores = [...localIgnores, ...parseGitignore(content)];
  } catch {}

  for (const entry of entries) {
    const name = entry.name;
    if (ALWAYS_EXCLUDE.has(name)) continue;
    const relChild = rel ? `${rel}/${name}` : name;
    if (matches(localIgnores, relChild, entry.isDirectory())) continue;

    if (entry.isDirectory()) {
      const sub = await walk(root, relChild, localIgnores);
      if (sub.files.length > 0 || sub.children.length > 0) {
        dirChildren.push({ name, path: relChild, ...sub });
      }
    } else if (entry.isFile()) {
      const stat = await fs.stat(path.join(abs, name));
      if (stat.size > 1024 * 1024) continue; // cap 1 MB
      const ext = path.extname(name).toLowerCase();
      let text = '';
      try {
        text = await fs.readFile(path.join(abs, name), 'utf8');
        if (text.includes('\0')) continue; // binary
      } catch {
        continue;
      }
      const lines = text.split('\n');
      const loc = lines.length;
      const buf = Buffer.from(text, 'utf8');
      const gzip = ext.match(/\.(ts|tsx|js|jsx|mjs|cjs|html|css)$/) ? await gzipSize(buf) : null;
      const tokens = estimateTokens(stat.size, text);
      const lang = EXT_LANG[ext] || null;
      // Structured TODO extraction — capture kind + line + text so the UI
      // can show the actual comment rather than a bare count.
      const todoPattern = /\b(TODO|FIXME|HACK|XXX|NOTE)\b[:\s]?\s*(.*)/;
      const todoList = [];
      for (let i = 0; i < lines.length && todoList.length < 20; i++) {
        const m = lines[i].match(todoPattern);
        if (m) todoList.push({ kind: m[1], line: i + 1, text: m[2].trim().slice(0, 160) });
      }
      // status heuristic
      let status = 'ok';
      if (!lang && !CONFIG_FILES.has(name)) status = 'ok';
      dirFiles.push({
        name,
        path: relChild,
        ext,
        language: lang,
        size: stat.size,
        gzip,
        loc,
        tokens,
        todos: todoList.length,
        todoEntries: todoList,
        status,
        mtime: stat.mtimeMs,
      });
    }
  }

  // Sort: directories first (children present), then files alphabetically
  dirChildren.sort((a, b) => a.name.localeCompare(b.name));
  dirFiles.sort((a, b) => a.name.localeCompare(b.name));

  return { files: dirFiles, children: dirChildren };
}

function rollup(node) {
  let size = 0,
    gzip = 0,
    tokens = 0,
    files = 0,
    loc = 0,
    todos = 0;
  for (const f of node.files) {
    size += f.size;
    gzip += f.gzip || 0;
    tokens += f.tokens;
    files += 1;
    loc += f.loc;
    todos += (f.todoEntries?.length ?? f.todos) || 0;
  }
  for (const c of node.children) {
    const sub = rollup(c);
    size += sub.size;
    gzip += sub.gzip;
    tokens += sub.tokens;
    files += sub.files;
    loc += sub.loc;
    todos += sub.todos;
    c.rollup = sub;
  }
  return { size, gzip, tokens, files, loc, todos };
}

function byLanguage(node, acc = new Map()) {
  for (const f of node.files) {
    if (!f.language) continue;
    const k = f.language.id;
    if (!acc.has(k)) acc.set(k, { ...f.language, loc: 0, tokens: 0, files: 0 });
    const r = acc.get(k);
    r.loc += f.loc;
    r.tokens += f.tokens;
    r.files += 1;
  }
  for (const c of node.children) byLanguage(c, acc);
  return acc;
}

function detectFrameworks(files) {
  const detected = new Set();
  for (const f of files) {
    if (f.name === 'package.json') {
      try {
        const pkg = JSON.parse(f._content || '{}');
        const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        if (all['react']) detected.add('React');
        if (all['react-router']) detected.add('React Router');
        if (all['remix']) detected.add('Remix');
        if (all['remix'] || all['@remix-run/react']) detected.add('Remix');
        if (all['vite']) detected.add('Vite');
        if (all['@vitejs/plugin-react']) detected.add('Vite');
        if (all['tailwindcss']) detected.add('Tailwind CSS');
        if (all['@xyflow/react']) detected.add('xyflow');
        if (all['framer-motion']) detected.add('Framer Motion');
        if (all['turbo']) detected.add('Turborepo');
        if (all['oxlint']) detected.add('oxlint');
      } catch {}
    }
  }
  return [...detected];
}

function flatten(node, out = []) {
  for (const f of node.files) out.push(f);
  for (const c of node.children) flatten(c, out);
  return out;
}

async function main() {
  const root = process.argv[2] || process.cwd();
  console.error(`[scan] walking ${root}`);
  const tree = await walk(root);
  // A pass to attach package.json contents for framework detection
  async function attachPkg(node) {
    for (const f of node.files) {
      if (f.name === 'package.json') {
        try {
          f._content = await fs.readFile(path.join(root, f.path), 'utf8');
        } catch {}
      }
    }
    for (const c of node.children) await attachPkg(c);
  }
  await attachPkg(tree);

  const totals = rollup(tree);
  const langMap = byLanguage(tree);
  const languages = [...langMap.values()].sort((a, b) => b.loc - a.loc);
  const allFiles = flatten(tree);
  const frameworks = detectFrameworks(allFiles);

  // Strip _content from output
  for (const f of allFiles) delete f._content;

  const capabilities = [];
  if (frameworks.includes('React')) capabilities.push({ icon: '✓', head: 'Renders a React WebUI', sub: 'React 19 + React Router v7 + Vite' });
  if (frameworks.includes('Remix')) capabilities.push({ icon: '✓', head: 'Integrates Remix 3 modules', sub: 'fetch-router, middleware, schemas' });
  if (frameworks.includes('Turborepo')) capabilities.push({ icon: '✓', head: 'Monorepo-structured', sub: 'pnpm workspaces + Turborepo' });
  if (frameworks.includes('Tailwind CSS')) capabilities.push({ icon: '✓', head: 'Styled with Tailwind v4', sub: 'Design tokens + liquid-glass' });
  if (allFiles.some((f) => f.path.startsWith('packages/spec'))) capabilities.push({ icon: '✓', head: 'Defines canonical schemas', sub: '@factstack/spec via Zod' });
  if (allFiles.some((f) => f.path.includes('eslint.config'))) capabilities.push({ icon: '✓', head: 'Enforces package boundaries', sub: 'eslint-plugin-boundaries + no-restricted-imports' });

  const broken = allFiles.filter((f) => f.status === 'broken').length;
  const stale = allFiles.filter((f) => f.status === 'stale').length;

  const output = {
    $schema: 'https://factstack.dev/schema/prototype.v1.json',
    generatedAt: new Date().toISOString(),
    project: {
      name: path.basename(path.resolve(root)),
      root: path.resolve(root),
      languages,
      frameworks,
    },
    summary: {
      oneLiner:
        frameworks.length > 0
          ? `A ${frameworks.slice(0, 3).join(' + ')} project`
          : 'Analyzed project',
      description:
        'Static code analyzer codebase. Monorepo with a shared @factstack/spec (Zod schemas), an isomorphic analyzer pipeline (walker → parsers → extractors → graph → scanners → emit), a Vite + React 19 + React Router v7 WebUI, and stubbed future surfaces (VS Code extension, Chrome extension, web app, MCP server).',
      capabilities,
      health: { broken, stale, todos: totals.todos, secrets: 0 },
    },
    stats: {
      files: totals.files,
      loc: totals.loc,
      size: totals.size,
      gzip: totals.gzip,
      tokens: totals.tokens,
    },
    tree,
    entryPoints: [
      // Best-effort detection — for a static-analyzer project, entry points
      // are the CLI and the UI dev server, not HTTP routes.
      { label: 'CLI', path: 'factstack', handlerFile: 'apps/cli/src/cli.ts', kind: 'cli' },
      { label: 'WebUI (dev)', path: 'localhost:3000', handlerFile: 'apps/ui-remix/app/root.tsx', kind: 'ui' },
      { label: 'Prototype', path: 'localhost:3001', handlerFile: 'prototype/index.html', kind: 'ui' },
    ],
    risks: [],
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
