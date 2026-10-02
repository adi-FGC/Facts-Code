/**
 * @factstack/scanners — dependency-manifest detection + parsing.
 *
 * Walks parsed manifests and emits a uniform DependencyManifest shape
 * regardless of ecosystem. The shape feeds two downstream surfaces:
 *
 *   1. The agent artifact (`agent.dependencyManifests[]`) — so the
 *      Vulnerabilities page + MCP server can query deps without
 *      re-walking + re-parsing on every read.
 *   2. The `factstack scan-vulns` CLI — uses the dep map to query
 *      OSV.dev, then writes findings back into `agent.vulnerabilities[]`.
 *
 * Scope for v0.6 MVP:
 *   - npm (package.json) — fully parsed: deps + devDeps + name + version
 *   - pypi / cargo / go / maven / rubygems — DETECTED via file basename,
 *     emitted with `ecosystem` set + empty deps. The OSV client supports
 *     all of these ecosystems, but the parsers are TODO. Detection-only
 *     means the UI still surfaces "we found 3 PyPI manifests but
 *     couldn't scan their deps yet" which is more honest than silence.
 *
 * Why no toml/xml parsers yet: each ecosystem needs ~150 LOC of parsing
 * for ~5% of FACTS users currently. Adding them is a follow-up day each;
 * the schema already accommodates them so adding deps later is purely
 * additive (no migration needed).
 *
 * Constraint C1: pure isomorphic — no node:* imports, no DOM. Same as
 * every other scanner in this package.
 */

import type { DependencyManifest, ManifestEcosystem } from '@factstack/spec';

/* Lockfile parsing (installed versions + transitive packages) is part of the
   same dependency surface; re-exported here so the package index picks it up. */
export * from './lockfiles.js';

/** Map a file path to a manifest ecosystem. Returns null when the path
 *  doesn't match any known manifest basename — so a caller's "is this
 *  a manifest?" check is one ternary. */
export function detectManifestEcosystem(path: string): ManifestEcosystem | null {
  const base = path.split('/').pop() ?? '';
  switch (base) {
    case 'package.json':
      return 'npm';
    case 'pyproject.toml':
      return 'pypi';
    case 'setup.py':
      return 'pypi';
    case 'requirements.txt':
      return 'pypi';
    case 'Cargo.toml':
      return 'cargo';
    case 'go.mod':
      return 'go';
    case 'pom.xml':
      return 'maven';
    case 'Gemfile':
      return 'rubygems';
    default:
      return null;
  }
}

/**
 * Parse one manifest file into a DependencyManifest. The text is the
 * file's contents; path is the project-relative location.
 *
 * Returns null when:
 *   - The path's basename isn't a recognized manifest (caller mistake;
 *     pre-check with detectManifestEcosystem to avoid).
 *   - The text fails to parse (malformed JSON, truncated TOML, etc.).
 *     Logging is the caller's responsibility — we return null so the
 *     analyzer can decide whether to surface as a risk.
 *
 * The contract: for any detected ecosystem, we ALWAYS return a manifest
 * record (even with empty deps) when the file parses. The presence of
 * a manifest with empty deps is meaningful — it tells the UI "we know
 * about this manifest, parser is just incomplete."
 */
export function scanDependencyManifest(path: string, text: string): DependencyManifest | null {
  const ecosystem = detectManifestEcosystem(path);
  if (!ecosystem) return null;

  switch (ecosystem) {
    case 'npm':
      return parseNpmPackageJson(path, text);
    case 'pypi':
    case 'cargo':
    case 'go':
    case 'maven':
    case 'rubygems':
      /* MVP: detection-only. Emit the manifest record so the UI can
         surface it as "scanned but no deps extracted yet." The next
         iteration adds proper parsers — schema accommodates them. */
      return {
        path,
        ecosystem,
        name: null,
        version: null,
        dependencies: {},
        devDependencies: {},
      };
    case 'unknown':
      return null;
  }
}

/* ─────────── npm: package.json ─────────── */

function parseNpmPackageJson(path: string, text: string): DependencyManifest | null {
  let json: {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  try {
    json = JSON.parse(text);
  } catch {
    /* Malformed JSON — caller may want to surface as a risk via the
       parse-error category. We just return null. */
    return null;
  }
  /* Validate shape — package.json with a non-object root (e.g. a JSON
     array, or null) shouldn't crash us. */
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

  return {
    path,
    ecosystem: 'npm',
    name: typeof json.name === 'string' ? json.name : null,
    version: typeof json.version === 'string' ? json.version : null,
    /* Merge peer + optional into deps. Most CI gates treat them the
       same as deps for security purposes — peer deps end up installed
       (npm >= 7 installs them); optional deps may install. The OSV
       query handles them uniformly. SCN-P2-06, two exceptions:
         - a peer ALSO in devDependencies is the library pattern (the dev
           install satisfies it locally; consumers bring their own copy),
           so it stays dev-only — shown, not graded;
         - a key in both dependencies and peerDependencies keeps its
           dependencies range, which is what npm installs.
       Optional still overrides dependencies, as npm does. */
    dependencies: sanitizeDeps({
      ...peersNotInDev(json.peerDependencies, json.devDependencies),
      ...(json.dependencies ?? {}),
      ...(json.optionalDependencies ?? {}),
    }),
    devDependencies: sanitizeDeps(json.devDependencies ?? {}),
  };
}

/** peerDependencies minus the keys devDependencies also declares. */
function peersNotInDev(peers: unknown, dev: unknown): Record<string, unknown> {
  if (!peers || typeof peers !== 'object') return {};
  const devMap = dev && typeof dev === 'object' ? dev : {};
  // fromEntries defines own properties — a `__proto__` key stays data.
  return Object.fromEntries(Object.entries(peers).filter(([k]) => !Object.hasOwn(devMap, k)));
}

/** Strip non-string values, normalize keys, drop empty-string versions. */
function sanitizeDeps(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, version] of Object.entries(raw)) {
    if (typeof name !== 'string' || !name) continue;
    if (typeof version !== 'string' || !version) continue;
    out[name] = version;
  }
  return out;
}

/* The OSV query list (dedupe, lockfile resolution, direct/transitive/dev
   scope) is built by buildOsvQueries in vulnerabilities.ts. */
