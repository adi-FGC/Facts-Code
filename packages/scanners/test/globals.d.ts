/**
 * Type-only slice of the one platform global the tests use beyond ES2022:
 * `performance.now()` for the time-budget checks (hcl, secrets, sql). Tests
 * type-check with the same `lib: ["ES2022"]` as src (no DOM lib, no
 * `@types/node`; same "declare the slice we use" tactic as `fetch` in
 * src/outdated.ts), so a test that reaches for `window`/`document` fails the
 * type-check instead of failing at runtime under vitest's Node environment.
 * If lib DOM or `@types/node` is ever added, delete this file: both declare
 * `performance` themselves.
 */
declare const performance: { now(): number };
