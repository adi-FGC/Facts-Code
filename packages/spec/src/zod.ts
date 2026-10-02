/**
 * The one `z` every FACTS schema is built with.
 *
 * zod 4 probes `new Function('')` the first time a `z.object()` is built (its
 * JIT fast path). A strict CSP without 'unsafe-eval' (the site, its scanner
 * worker, an MV3 extension) reports that probe as a securitypolicyviolation
 * even though zod catches it. `jitless` skips the probe and the JIT; parse
 * results are identical. Every schema module imports `z` from here, so ESM
 * evaluation order applies the config before any schema exists. The config
 * lives on globalThis, so it reaches every zod copy in the realm.
 *
 * package.json lists this file under `sideEffects`, so a bundler never drops
 * the config call as an unused re-export.
 */

import { z } from 'zod';

z.config({ jitless: true });

export { z };
