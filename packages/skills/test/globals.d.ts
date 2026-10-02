/**
 * Type-only slice of the platform globals the tests use beyond ES2022:
 * `TextEncoder` for byte counts (renderers.test.ts, helpers/memory-writer.ts),
 * and `URL` + `import.meta.url` to locate src/ (install.test.ts). Tests
 * type-check with the same `lib: ["ES2022"]` as src (no DOM lib, no
 * `@types/node`; the scanners tests use the same tactic), so a test that
 * reaches for `window`/`document` fails the type-check instead of failing at
 * runtime under vitest's Node environment. If lib DOM or `@types/node` is
 * ever added, delete this file: both declare these globals themselves.
 */
/* eslint-disable no-unused-vars -- type-only declarations: core no-unused-vars
   reads the parameter names of bodiless signatures as unused variables. */

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class URL {
  constructor(url: string, base?: string | URL);
  readonly href: string;
}

interface ImportMeta {
  readonly url: string;
}
