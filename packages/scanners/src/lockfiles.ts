/**
 * Lockfile parsing — what is actually INSTALLED, not what a manifest allows.
 *
 * A package.json says `"lodash": "^4.17.0"`; the lockfile says `npm ci`
 * installs 4.17.21. The CVE scan asks OSV about the installed version, so it
 * reads the lockfile when there is one and only falls back to the declared
 * range's lower bound (labelled `declared-range`) when there isn't. Lockfiles
 * also list every TRANSITIVE package, which a manifest-only scan never sees.
 *
 * Formats: pnpm-lock.yaml (v5.x, v6, v9), package-lock.json /
 * npm-shrinkwrap.json (v1 nested `dependencies`, v2/v3 `packages` map) and
 * yarn.lock (v1 and berry). pnpm + berry lockfiles are YAML; they are read with
 * the small indentation-subset parser below (block maps, scalars, quoted keys,
 * block sequences) — lockfiles only ever use that subset, so no YAML dependency.
 *
 * Constraint C1: pure isomorphic — text in, data out. No node:*, no DOM, no
 * I/O; the CLI, MCP server and browser each read the file and pass its text.
 */

import { LOCKFILE_NAMES, type DependencyManifest } from '@factstack/spec';

/* ─────────── public types ─────────── */

export type LockfileKind = 'pnpm' | 'npm' | 'yarn-v1' | 'yarn-berry';

/** One installed registry package. */
export interface LockedPackage {
  /** Registry name — an alias (`"x": "npm:lodash@^4"`) resolves to `lodash`. */
  name: string;
  /** Concrete installed version (peer/build suffixes stripped). */
  version: string;
  /** Set when the lockfile records it (package-lock `dev`, pnpm v5/v6 `dev`). */
  dev?: boolean;
}

export interface ParsedLockfile {
  /** Project-relative lockfile path, e.g. "pnpm-lock.yaml", "apps/web/package-lock.json". */
  path: string;
  kind: LockfileKind;
  /** Direct deps per importer (workspace package). Key: the importer's dir
   *  relative to the lockfile's dir ('' = the lockfile's own dir). Value: the
   *  declared dependency key (the alias key for `npm:` aliases) → installed. */
  importers: Map<string, Map<string, LockedPackage>>;
  /** yarn only: descriptor exactly as the lockfile writes it
   *  ("lodash@^4.17.0", berry "lodash@npm:^4.17.0") → installed. */
  descriptors: Map<string, LockedPackage>;
  /** Every installed registry package, deduped by name@version. Workspace
   *  links, git, file: and tarball installs are never listed. */
  packages: LockedPackage[];
}

/** Lockfile basenames, in the order a CLI should probe them. Re-exported from
 *  @factstack/spec — the one list, which the browser GitHub scan downloads
 *  too, so both hosts parse the same lockfiles (INV7). */
export { LOCKFILE_NAMES };

export function isLockfilePath(path: string): boolean {
  return (LOCKFILE_NAMES as readonly string[]).includes(baseOf(path));
}

/**
 * Parse one lockfile. Returns null when the basename isn't a lockfile or the
 * text doesn't parse — the caller then scans declared ranges, as before.
 */
export function parseLockfile(path: string, text: string): ParsedLockfile | null {
  const p = path.replace(/\\/g, '/');
  switch (baseOf(p)) {
    case 'pnpm-lock.yaml':
      return parsePnpmLock(p, text);
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return parseNpmLock(p, text);
    case 'yarn.lock':
      return /^__metadata:/m.test(text)
        ? parseYarnBerry(p, parseYamlSubset(text))
        : parseYarnV1(p, text);
    default:
      return null;
  }
}

/**
 * The installed package a manifest's direct dependency resolved to, from the
 * NEAREST lockfile that covers the manifest (same dir or an ancestor). null
 * when no lockfile installs this manifest (a fixture dir outside the
 * workspace) or the governing lockfile doesn't lock the dep (stale lockfile).
 */
export function resolveInstalled(
  lockfiles: readonly ParsedLockfile[],
  manifestPath: string,
  depKey: string,
  declared: string,
): LockedPackage | null {
  const dir = dirOf(manifestPath);
  const covering = lockfiles
    .filter((l) => {
      const ld = dirOf(l.path);
      return ld === '' || dir === ld || dir.startsWith(ld + '/');
    })
    .sort((a, b) => dirOf(b.path).length - dirOf(a.path).length);
  for (const lock of covering) {
    const ld = dirOf(lock.path);
    const imp = lock.importers.get(dir === ld ? '' : dir.slice(ld ? ld.length + 1 : 0));
    const hit = imp?.get(depKey) ?? yarnDescriptor(lock, depKey, declared);
    if (hit) return hit;
    if (imp) return null; // this lockfile governs the manifest; the dep just isn't locked
  }
  return null;
}

/**
 * Record each npm manifest's lockfile-resolved direct-dep versions on an
 * additive `resolved` map (dep key → installed version), so an artifact can
 * carry them to consumers that never see the lockfile (the dashboard's weekly
 * refresh, reconcile after re-analyze). Manifests with nothing resolved are
 * returned unchanged. SCN-P2-01: `resolved` is on the spec's
 * DependencyManifest, so the result is plain `M[]` (a local
 * `resolved?: Record` clashed with the spec's under exactOptionalPropertyTypes).
 */
export function attachResolvedVersions<M extends DependencyManifest>(
  manifests: readonly M[],
  lockfiles: readonly ParsedLockfile[],
): M[] {
  return manifests.map((m) => {
    if (m.ecosystem !== 'npm' || lockfiles.length === 0) return m;
    const pairs: Array<[string, string]> = [];
    // `?? {}`: legacy/raw dataset JSON (the dashboard) may omit either map.
    for (const [key, declared] of [
      ...Object.entries(m.dependencies ?? {}),
      ...Object.entries(m.devDependencies ?? {}),
    ]) {
      const hit = resolveInstalled(lockfiles, m.path, key, declared);
      if (hit) pairs.push([key, hit.version]);
    }
    // fromEntries defines own properties — a `__proto__` dep key stays data.
    return pairs.length ? { ...m, resolved: Object.fromEntries(pairs) } : m;
  });
}

/** Lockfile paths worth probing for a set of manifests: each manifest's dir
 *  and every ancestor, times every lockfile name. For CLI/MCP disk reads. */
export function lockfileCandidates(manifestPaths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const p of manifestPaths) {
    let d = dirOf(p);
    for (;;) {
      dirs.add(d);
      if (!d) break;
      const slash = d.lastIndexOf('/');
      d = slash >= 0 ? d.slice(0, slash) : '';
    }
  }
  return [...dirs].sort().flatMap((d) => LOCKFILE_NAMES.map((n) => (d ? `${d}/${n}` : n)));
}

/* ─────────── spec helpers (shared with normalizeNpmVersion) ─────────── */

/**
 * Split an npm alias spec `npm:<name>@<range>` into the REAL package and its
 * range. `npm:lodash` (no range) gives range ''. Returns null for anything
 * that isn't an alias — including berry's protocol-qualified plain range
 * `npm:^4.17.0`, which names no package.
 */
export function parseNpmAlias(spec: string): { name: string; range: string } | null {
  if (!spec.startsWith('npm:')) return null;
  const rest = spec.slice(4);
  const at = rest.indexOf('@', rest.startsWith('@') ? 1 : 0);
  const name = at > 0 ? rest.slice(0, at) : rest;
  if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(name)) return null;
  // `npm:4.17.21` / `npm:1.x` qualify a range; `npm:vue` / `npm:7zip-bin` name a package.
  if (at < 0 && /^(?:v?\d+(?:\.[\dxX*]+){0,2}(?:[-+][0-9A-Za-z.-]*)?|[xX*])$/.test(name))
    return null;
  return { name, range: at > 0 ? rest.slice(at + 1) : '' };
}

/** False for specs that don't name a registry version: workspace/file/link/
 *  git/tarball/path protocols, pnpm catalogs, and GitHub `user/repo`
 *  shorthand (a registry range never contains '/'). */
export function isRegistrySpec(spec: string): boolean {
  const s = spec.trim();
  if (
    /^(workspace|file|link|portal|patch|exec|catalog|git|git\+[a-z]+|github|gitlab|bitbucket|gist|https?):/i.test(
      s,
    )
  )
    return false;
  if (/^git@/.test(s)) return false;
  return !s.includes('/');
}

/** A concrete semver: X.Y.Z with optional prerelease/build. */
function isConcreteVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v);
}

/* ─────────── pnpm ─────────── */

function parsePnpmLock(path: string, text: string): ParsedLockfile | null {
  const doc = parseYamlSubset(text);
  const major = parseInt(str(doc['lockfileVersion']) ?? '', 10);
  if (!Number.isFinite(major)) return null;
  const importers = new Map<string, Map<string, LockedPackage>>();
  /* Single-project v5/v6 lockfiles keep their deps at the top level. */
  const rawImporters = asMap(doc['importers']) ?? { '.': doc };
  for (const [dir, rawImp] of Object.entries(rawImporters)) {
    const imp = asMap(rawImp);
    if (!imp) continue;
    const deps = new Map<string, LockedPackage>();
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [key, val] of Object.entries(asMap(imp[field]) ?? {})) {
        // v5: `name: version`; v6/v9: `name: { specifier, version }`.
        const ref = typeof val === 'string' ? val : str(asMap(val)?.['version']);
        const pkg = ref ? pnpmRef(key, ref, major) : null;
        if (pkg) deps.set(key, pkg);
      }
    }
    importers.set(dir === '.' ? '' : dir, deps);
  }
  const packages = new PackageSet();
  for (const [key, val] of Object.entries(asMap(doc['packages']) ?? {})) {
    const pkg = pnpmDepPath(key, major);
    if (!pkg) continue;
    const dev = str(asMap(val)?.['dev']);
    packages.add(dev === 'true' || dev === 'false' ? { ...pkg, dev: dev === 'true' } : pkg);
  }
  return { path, kind: 'pnpm', importers, descriptors: new Map(), packages: packages.list() };
}

/** Peer-resolution suffixes: v6/v9 `1.2.3(react@18.3.1)`, v5 `1.2.3_react@18.3.1`. */
function stripPeers(v: string, major: number): string {
  const paren = v.indexOf('(');
  let out = paren >= 0 ? v.slice(0, paren) : v;
  if (major < 6) {
    const u = out.indexOf('_');
    if (u >= 0) out = out.slice(0, u);
  }
  return out;
}

/** An importer's version ref: a bare version, a v9 alias `name@ver`, a v5/v6
 *  dep path `/name@ver` / `/name/ver`, or a non-registry `link:`/`file:`. */
function pnpmRef(depKey: string, ref: string, major: number): LockedPackage | null {
  if (/^(link|file|workspace|portal):/.test(ref)) return null;
  if (ref.startsWith('/')) return pnpmDepPath(ref, major);
  const bare = stripPeers(ref, major);
  if (isConcreteVersion(bare)) return { name: depKey, version: bare };
  return pnpmDepPath(ref, major);
}

/** A `packages:` key → name + version. v9 `name@ver`, v6 `/name@ver(peers)`,
 *  v5 `/name/ver_peers`. git/tarball keys have no concrete version → null. */
function pnpmDepPath(key: string, major: number): LockedPackage | null {
  const k = key.startsWith('/') ? key.slice(1) : key;
  if (major < 6) {
    const parts = k.split('/');
    const scoped = parts[0]?.startsWith('@') ?? false;
    if (parts.length !== (scoped ? 3 : 2)) return null;
    const name = scoped ? `${parts[0]}/${parts[1]}` : parts[0]!;
    const version = stripPeers(parts[scoped ? 2 : 1]!, major);
    return isConcreteVersion(version) ? { name, version } : null;
  }
  const bare = stripPeers(k, major);
  const at = bare.lastIndexOf('@');
  if (at <= 0) return null;
  const version = bare.slice(at + 1);
  return isConcreteVersion(version) ? { name: bare.slice(0, at), version } : null;
}

/* ─────────── npm (package-lock.json / npm-shrinkwrap.json) ─────────── */

type Json = Record<string, unknown>;

function parseNpmLock(path: string, text: string): ParsedLockfile | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const root = asMap(json);
  if (!root) return null;
  const importers = new Map<string, Map<string, LockedPackage>>();
  const packages = new PackageSet();
  const pk = asMap(root['packages']);
  if (pk) {
    /* v2/v3: a flat map keyed by install path. Keys without `node_modules/`
       are importers ('' = root, 'packages/a' = a workspace). */
    for (const [key, raw] of Object.entries(pk)) {
      const entry = asMap(raw);
      if (!entry) continue;
      const nm = key.lastIndexOf('node_modules/');
      if (nm < 0) {
        const deps = new Map<string, LockedPackage>();
        for (const field of [
          'dependencies',
          'devDependencies',
          'optionalDependencies',
          'peerDependencies',
        ]) {
          for (const name of Object.keys(asMap(entry[field]) ?? {})) {
            const hit = npmResolve(pk, key, name);
            if (hit) deps.set(name, hit);
          }
        }
        importers.set(key, deps);
        continue;
      }
      const pkg = npmEntry(entry, key.slice(nm + 'node_modules/'.length));
      if (pkg) packages.add(pkg);
    }
  } else {
    /* v1: a nested `dependencies` tree; top level = what the root resolves. */
    const top = new Map<string, LockedPackage>();
    walkNpmV1(asMap(root['dependencies']), packages, top);
    importers.set('', top);
  }
  return { path, kind: 'npm', importers, descriptors: new Map(), packages: packages.list() };
}

/** A v2/v3 `packages` entry → installed package; null for workspace links,
 *  git/file installs and anything without a concrete version. */
function npmEntry(entry: Json, pathName: string): LockedPackage | null {
  if (entry['link'] === true) return null;
  const resolved = str(entry['resolved']) ?? '';
  if (/^(git|file:|github:)/.test(resolved)) return null;
  const version = str(entry['version']) ?? '';
  if (!isConcreteVersion(version)) return null;
  const name = str(entry['name']) || pathName; // aliases record the real name
  return entry['dev'] === true ? { name, version, dev: true } : { name, version };
}

/** Node module resolution from an importer dir: `<dir>/node_modules/<name>`,
 *  then each ancestor dir, then the root `node_modules/<name>`. */
function npmResolve(pk: Json, importerDir: string, name: string): LockedPackage | null {
  let dir = importerDir;
  for (;;) {
    const key = (dir ? dir + '/' : '') + 'node_modules/' + name;
    if (Object.hasOwn(pk, key)) {
      const entry = asMap(pk[key]);
      return entry ? npmEntry(entry, name) : null;
    }
    if (!dir) return null;
    const slash = dir.lastIndexOf('/');
    dir = slash >= 0 ? dir.slice(0, slash) : '';
  }
}

function walkNpmV1(
  deps: Json | null,
  into: PackageSet,
  top: Map<string, LockedPackage> | null,
): void {
  for (const [key, raw] of Object.entries(deps ?? {})) {
    const entry = asMap(raw);
    if (!entry) continue;
    let name = key;
    let version = str(entry['version']) ?? '';
    const alias = parseNpmAlias(version); // v1 records aliases as `npm:real@1.2.3`
    if (alias) {
      name = alias.name;
      version = alias.range;
    }
    const resolved = str(entry['resolved']) ?? '';
    if (isConcreteVersion(version) && !/^(git|file:)/.test(resolved)) {
      const pkg: LockedPackage =
        entry['dev'] === true ? { name, version, dev: true } : { name, version };
      into.add(pkg);
      top?.set(key, pkg);
    }
    walkNpmV1(asMap(entry['dependencies']), into, null);
  }
}

/* ─────────── yarn ─────────── */

/** yarn v1: `"a@^1", "a@^1.1":` headers, then `  version "1.2.3"` lines. */
function parseYarnV1(path: string, text: string): ParsedLockfile {
  const descriptors = new Map<string, LockedPackage>();
  const packages = new PackageSet();
  let heads: string[] = [];
  let version = '';
  const flush = () => {
    for (const d of heads) {
      const pkg = yarnV1Package(d, version);
      if (!pkg) continue;
      descriptors.set(d, pkg);
      packages.add(pkg);
    }
    heads = [];
    version = '';
  };
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const body = line.trim();
    if (!body || body.startsWith('#')) continue;
    if (line === line.trimStart()) {
      flush();
      if (body.endsWith(':')) heads = splitDescriptors(body.slice(0, -1));
      continue;
    }
    const m = /^ {2}version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (m) version = m[1]!;
  }
  flush();
  return { path, kind: 'yarn-v1', importers: new Map(), descriptors, packages: packages.list() };
}

function yarnV1Package(descriptor: string, version: string): LockedPackage | null {
  const at = descriptor.indexOf('@', descriptor.startsWith('@') ? 1 : 0);
  if (at <= 0 || !isConcreteVersion(version)) return null;
  let name = descriptor.slice(0, at);
  let range = descriptor.slice(at + 1);
  const alias = parseNpmAlias(range);
  if (alias) {
    name = alias.name;
    range = alias.range;
  }
  return isRegistrySpec(range) ? { name, version } : null;
}

/** yarn berry: YAML; `resolution: "name@npm:1.2.3"` marks a registry install,
 *  `name@workspace:<dir>` entries list each workspace's declared deps. */
function parseYarnBerry(path: string, doc: Json): ParsedLockfile {
  const descriptors = new Map<string, LockedPackage>();
  const packages = new PackageSet();
  const workspaces: Array<[string, Json]> = [];
  for (const [key, raw] of Object.entries(doc)) {
    const entry = asMap(raw);
    if (key === '__metadata' || !entry) continue;
    const resolution = str(entry['resolution']) ?? '';
    const at = resolution.indexOf('@', resolution.startsWith('@') ? 1 : 0);
    if (at <= 0) continue;
    const ref = resolution.slice(at + 1);
    if (ref.startsWith('workspace:')) {
      workspaces.push([ref.slice('workspace:'.length), asMap(entry['dependencies']) ?? {}]);
      continue;
    }
    // git / file / patch / portal / link resolutions are not registry installs.
    if (!ref.startsWith('npm:') || !isConcreteVersion(ref.slice(4))) continue;
    const pkg = { name: resolution.slice(0, at), version: ref.slice(4) };
    packages.add(pkg);
    for (const d of splitDescriptors(key)) descriptors.set(d, pkg);
  }
  const importers = new Map<string, Map<string, LockedPackage>>();
  for (const [dir, deps] of workspaces) {
    const map = new Map<string, LockedPackage>();
    for (const [dep, range] of Object.entries(deps)) {
      const hit = descriptors.get(`${dep}@${str(range) ?? ''}`);
      if (hit) map.set(dep, hit);
    }
    importers.set(dir === '.' ? '' : dir, map);
  }
  return { path, kind: 'yarn-berry', importers, descriptors, packages: packages.list() };
}

/** Descriptor lookup for manifests yarn doesn't list as an importer. Berry
 *  qualifies bare ranges with `npm:` (`lodash@npm:^4.17.0`). */
function yarnDescriptor(
  lock: ParsedLockfile,
  depKey: string,
  declared: string,
): LockedPackage | null {
  if (lock.kind !== 'yarn-v1' && lock.kind !== 'yarn-berry') return null;
  return (
    lock.descriptors.get(`${depKey}@${declared}`) ??
    lock.descriptors.get(`${depKey}@npm:${declared}`) ??
    null
  );
}

function splitDescriptors(header: string): string[] {
  return header
    .split(/,\s*/)
    .map((d) => unquote(d.trim()))
    .filter(Boolean);
}

/* ─────────── YAML subset ─────────── */

/**
 * Indentation-based YAML subset: block mappings, `key: scalar`, single/double
 * quoted keys and values, block sequences of scalars, comments. Flow
 * collections (`{integrity: …}`, `[x64]`) stay raw strings — lockfile readers
 * never need their insides. Maps are null-prototype, so a hostile key like
 * `__proto__` is plain data. Never throws.
 */
function parseYamlSubset(text: string): Json {
  const root: Json = Object.create(null) as Json;
  // Each frame: the indent of the key that owns the container.
  const stack: Array<{ indent: number; node: Json | unknown[] }> = [{ indent: -1, node: root }];
  let pending: { parent: Json; key: string; indent: number } | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const body = line.trimStart();
    if (!body || body.startsWith('#') || body === '---' || body === '...') continue;
    const indent = line.length - body.length;
    const isItem = body === '-' || body.startsWith('- ');
    if (pending) {
      // `key:` with no value opens a map, or a sequence (items may sit at the key's own indent).
      if (indent > pending.indent || (isItem && indent === pending.indent)) {
        const child: Json | unknown[] = isItem ? [] : (Object.create(null) as Json);
        pending.parent[pending.key] = child;
        stack.push({ indent: pending.indent, node: child });
      }
      pending = null;
    }
    while (stack.length > 1) {
      const top = stack[stack.length - 1]!;
      const inside = Array.isArray(top.node)
        ? indent > top.indent || (isItem && indent === top.indent)
        : indent > top.indent;
      if (inside) break;
      stack.pop();
    }
    const node = stack[stack.length - 1]!.node;
    if (Array.isArray(node)) {
      if (isItem) node.push(yamlScalar(body.slice(1).trim()));
      continue; // nested content under an item: not needed by lockfile readers
    }
    if (isItem) continue;
    const kv = splitYamlKey(body);
    if (!kv) continue;
    if (kv.value === '') {
      node[kv.key] = null;
      pending = { parent: node, key: kv.key, indent };
    } else {
      node[kv.key] = yamlScalar(kv.value);
    }
  }
  return root;
}

/** `key: value` / `'quoted key': value` / `key:` → parts; null when not a mapping line. */
function splitYamlKey(body: string): { key: string; value: string } | null {
  if (body.startsWith("'") || body.startsWith('"')) {
    const end = quoteEnd(body);
    if (end < 0 || body[end + 1] !== ':') return null;
    return { key: unquote(body.slice(0, end + 1)), value: body.slice(end + 2).trim() };
  }
  // The first ':' followed by whitespace or end of line (so `a@https://x` stays whole).
  const m = /^(.*?):(?:\s+(.*))?$/.exec(body);
  return m ? { key: m[1]!.trim(), value: (m[2] ?? '').trim() } : null;
}

function yamlScalar(value: string): string {
  if (value.startsWith("'") || value.startsWith('"')) {
    const end = quoteEnd(value);
    return end > 0 ? unquote(value.slice(0, end + 1)) : value;
  }
  const hash = value.indexOf(' #');
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

/** Index of the closing quote of a quoted scalar starting at 0, or -1. */
function quoteEnd(s: string): number {
  const q = s[0];
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") {
        i++; // '' is an escaped single quote
        continue;
      }
      return i;
    }
  }
  return -1;
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'"))
    return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

/* ─────────── small helpers ─────────── */

class PackageSet {
  private readonly seen = new Map<string, LockedPackage>();
  add(p: LockedPackage): void {
    const key = `${p.name}@${p.version}`;
    if (!this.seen.has(key)) this.seen.set(key, p);
  }
  list(): LockedPackage[] {
    return [...this.seen.values()];
  }
}

function asMap(v: unknown): Json | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
}

function baseOf(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? '';
}

/** Project-relative dir of a file path ('' for the project root). */
function dirOf(path: string): string {
  const p = path.replace(/\\/g, '/');
  const slash = p.lastIndexOf('/');
  return slash >= 0 ? p.slice(0, slash) : '';
}
