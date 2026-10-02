/**
 * Every documented MCP launch passes the project the way the server reads it.
 *
 * apps/mcp-server/src/paths.ts (parseServerArgs) reads only `--root <dir>`
 * (`-r`, `--root=`) and the `login` sub-command. A positional `.` is ignored,
 * so the root silently falls back to a guess from the client's working
 * directory. Regression: docs/pack-playbook.html showed
 * `"args": ["-y", "factstack-mcp", "."]` and `factstack-mcp .`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const files = [
  'README.md',
  ...readdirSync(join(ROOT, 'docs'), { recursive: true })
    .map((f) => `docs/${String(f).replace(/\\/g, '/')}`)
    .filter((f) => /\.(html|md)$/.test(f)),
  ...readdirSync(join(ROOT, 'apps/ui-remix/public'))
    .filter((f) => f.endsWith('.html'))
    .map((f) => `apps/ui-remix/public/${f}`),
];

const text = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Arguments after `factstack-mcp` the server would ignore (positionals). */
function ignoredArgs(rest) {
  const bad = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--root' || a === '-r') i++;
    else if (a === 'login' || a.startsWith('-')) continue;
    else bad.push(a);
  }
  return bad;
}

/** Every `factstack-mcp` launch in a doc: JSON `"args"` arrays and inline code. */
function launches(raw) {
  const out = [];
  const plain = text(raw);
  for (const m of plain.matchAll(/"args"\s*:\s*\[([^\]]*)\]/g)) {
    const args = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    const i = args.indexOf('factstack-mcp');
    if (i >= 0) out.push(args.slice(i + 1));
  }
  /* HTML <code> is entity-decoded; Markdown backticks are literal (`<path>`). */
  const code = [
    ...[...raw.matchAll(/<code>([^<]*)<\/code>/g)].map((m) => text(m[1])),
    ...[...raw.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]),
  ];
  for (const c of code) {
    const cmd = c.match(/factstack-mcp((?:\s+\S+)*)\s*$/);
    if (cmd) out.push(cmd[1].trim().split(/\s+/).filter(Boolean));
  }
  return out;
}

describe('documented MCP launches', () => {
  it('flags a positional root', () => {
    expect(ignoredArgs(['.'])).toEqual(['.']);
    expect(ignoredArgs(['--root', '.'])).toEqual([]);
    expect(ignoredArgs(['login', '--root=/p'])).toEqual([]);
    expect(launches('<code>factstack-mcp .</code>')).toEqual([['.']]);
    expect(
      launches('"args": [<span>"-y"</span>, <span>"factstack-mcp"</span>, <span>"."</span>]'),
    ).toEqual([['.']]);
  });

  it.each(files)('%s passes the project with --root', (file) => {
    const bad = launches(readFileSync(join(ROOT, file), 'utf8')).flatMap(ignoredArgs);
    expect(bad).toEqual([]);
  });
});
