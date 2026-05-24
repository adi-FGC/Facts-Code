/**
 * pnpm install-time hooks.
 *
 * pnpm reads this file automatically (when present at the repo root)
 * and calls `hooks.readPackage(pkg)` for every package manifest it
 * resolves — both top-level and transitive. The returned object is
 * what pnpm uses for further resolution. We use it to strip
 * supply-chain hazards before they reach the lockfile or the install
 * tree.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Why this exists — ERR_PNPM_EXOTIC_SUBDEP defense
 * ─────────────────────────────────────────────────────────────────────
 *
 * `remix@3.0.0-beta.0` shipped a `@remix-run/node-serve` subpackage
 * which depended on `uWebSockets.js` — a C++ WebSocket library NOT
 * published to npm. It's installed via a github tarball URL:
 *
 *   "uWebSockets.js":
 *     "https://github.com/uNetworking/uWebSockets.js/tarball/v20.x"
 *
 * pnpm 9+ added a `blockExoticSubdeps` setting (often enabled in
 * strict-mode CI configs) that rejects ANY subdep with a non-registry
 * spec — git URLs, github: refs, file: paths, tarball URLs. That
 * triggered `ERR_PNPM_EXOTIC_SUBDEP` on first install in those
 * environments.
 *
 * Upstream Remix removed `node-serve` in beta.1 (commit `0be6e9a4`,
 * "Remove node-serve from beta"). Our `f7019c7` bump to beta.2 pulled
 * the removal into our lockfile. So today the install is clean.
 *
 * This hook is belt-and-suspenders for the future:
 *
 *   1. If a future Remix beta reintroduces node-serve (or any other
 *      transitive starts pulling uWebSockets.js), we strip the dep
 *      at manifest-read time — pnpm never sees the exotic ref.
 *   2. If a different package starts referencing `uWebSockets.js` for
 *      its WebSocket needs (hyper-express, socket.io-adapter-cluster,
 *      etc.), same deal.
 *
 * Safety of stripping: this is a browser-side dashboard. We never
 * need a native WebSocket server. The only consumers of uWebSockets.js
 * are server-side socket implementations, none of which we ship. If
 * we ever add server-side WebSocket support, we'd remove this hook
 * deliberately rather than silently grow a broken install.
 *
 * Hook is intentionally narrow: only strips `uWebSockets.js`, doesn't
 * touch any other dep. If another exotic subdep ever shows up we'll
 * add it explicitly — a sweeping "delete all git refs" rule would be
 * too easy to forget about.
 */

/** Stripped deps log (printed once per install). */
const EXOTIC_DROPPED = new Set();

/** The exact set of package names we strip. Narrow on purpose — see
 *  the preamble. Add new names ONLY with a comment explaining why. */
const STRIP_NAMES = new Set([
  // C++ WebSocket library, installed via github tarball, pulled by
  // @remix-run/node-serve (removed upstream in beta.1).
  'uWebSockets.js',
]);

function readPackage(pkg, _context) {
  if (!pkg || typeof pkg !== 'object') return pkg;

  /* Walk the four dep buckets pnpm consults during resolution. We
     mutate in place because that's the documented contract — pnpm
     re-reads the returned object as if it were the manifest. */
  const buckets = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
  for (const bucket of buckets) {
    const deps = pkg[bucket];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (STRIP_NAMES.has(name)) {
        if (!EXOTIC_DROPPED.has(`${pkg.name}::${name}`)) {
          /* Log once per (parent, victim) pair so multiple instances
             of the same dep across the tree don't spam. _context.log
             is pnpm's logging API; falling back to console.log keeps
             this safe under older pnpm versions where context.log
             isn't passed. */
          const msg = `[.pnpmfile] stripping ${bucket}.${name} from ${pkg.name}@${pkg.version}`;
          if (_context && typeof _context.log === 'function') _context.log(msg);
          else console.log(msg);
          EXOTIC_DROPPED.add(`${pkg.name}::${name}`);
        }
        delete deps[name];
      }
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
