/**
 * deploy-infra#7 — the CLI scripts' "run only when started as a script" guard.
 *
 * bundle.mjs (and ui-xss-audit.mjs) compared `process.argv[1]` — the path as
 * typed — with `import.meta.url`, which Node realpaths. Started through a
 * junction, symlink or subst'd checkout the two differ, so `bundle` and
 * `pack:dry-run` did nothing and exited 0, and the owner could then publish an
 * older publish/ folder. Both now use `import.meta.main`, like the MCP
 * server's bundle. Each case here runs a script through a junction to
 * apps/cli/scripts and fails fast, so nothing is built.
 *
 * cli-rev-7: the junction used to point at ALL of apps/cli, and the temp dir
 * holding it was removed with a recursive rm — one Node change that followed
 * junctions away from wiping the package. It now links scripts/ only (Node
 * realpaths the entry, so bundle.mjs still finds CLI_ROOT), and the link
 * itself is dropped before the temp dir is.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CLI_ROOT, cliReleaseBlockers } from '../bundle.mjs';
import { ownLicenseFile } from '../lib/release-guard.mjs';

const SCRIPTS = path.join(CLI_ROOT, 'scripts');

const linkExists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Remove the link `linked` (never what it points at), then — only once it is
 *  gone — the temp dir `dir` that held it. A link that will not go leaves
 *  the temp dir behind rather than risk a recursive delete through it. */
function removeLinkThenDir(dir: string, linked: string): void {
  try {
    unlinkSync(linked); // a symlink, or a junction on Windows
  } catch {
    try {
      rmdirSync(linked); // removes a junction's reparse point, never its target
    } catch {
      /* checked below */
    }
  }
  if (!linkExists(linked)) rmSync(dir, { recursive: true, force: true });
}

let tmp = '';
let linked = '';
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'facts-cli-entry-'));
  linked = path.join(tmp, 'linked-scripts');
  symlinkSync(SCRIPTS, linked, 'junction'); // a junction on Windows (no admin), else a symlink
});
afterAll(() => removeLinkThenDir(tmp, linked));

const run = (script: string, args: string[]) => {
  const r = spawnSync(process.execPath, [path.join(linked, script), ...args], {
    cwd: tmp,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

describe('the test junction (cli-rev-7)', () => {
  it('links apps/cli/scripts only, never the whole package', () => {
    expect(realpathSync.native(linked)).toBe(realpathSync.native(SCRIPTS));
  });

  it('cleanup drops the link first and never deletes through it', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'facts-cli-link-'));
    const target = path.join(scratch, 'target');
    const holder = path.join(scratch, 'holder');
    mkdirSync(target);
    mkdirSync(holder);
    writeFileSync(path.join(target, 'keep.txt'), 'x');
    const link = path.join(holder, 'link');
    symlinkSync(target, link, 'junction');
    expect(readFileSync(path.join(link, 'keep.txt'), 'utf8')).toBe('x');
    removeLinkThenDir(holder, link);
    expect(existsSync(holder)).toBe(false);
    expect(readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('x');
    rmSync(scratch, { recursive: true, force: true }); // no link left in it
  });
});

describe('CLI scripts started through a junction/symlink still run (deploy-infra#7)', () => {
  it('bundle.mjs runs its --out guard and fails loudly instead of a silent exit 0', () => {
    const foreign = path.join(tmp, 'foreign');
    mkdirSync(foreign);
    writeFileSync(path.join(foreign, 'keep.txt'), 'x');
    const r = run('bundle.mjs', ['--out', foreign]);
    expect(r.out).toMatch(/\[bundle\] failed: refusing --out .*not an earlier publish folder/);
    expect(r.status).toBe(1);
    expect(readFileSync(path.join(foreign, 'keep.txt'), 'utf8')).toBe('x');
  });

  it('bundle.mjs --release is refused while the license is unsettled (nothing written)', () => {
    const cliPkg = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8'));
    const blockers = cliReleaseBlockers(cliPkg, ownLicenseFile(CLI_ROOT));
    // Once the owner settles the license this would build for real: skip then.
    if (blockers.length === 0) return;
    const out = path.join(tmp, 'release-out');
    const r = run('bundle.mjs', ['--release', '--out', out]);
    expect(r.out).toContain('refusing to bundle a release (nothing written)');
    expect(r.status).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it('lib/ui-xss-audit.mjs audits the file it is given', () => {
    const html = path.join(tmp, 'sink.html');
    writeFileSync(
      html,
      '<script type="module">\ndocument.body.innerHTML = location.hash;\n</script>\n',
    );
    const r = run(path.join('lib', 'ui-xss-audit.mjs'), [html]);
    expect(r.out).toMatch(/1 unsafe value\(s\) reach an HTML sink/);
    expect(r.status).toBe(1);
  });
});
