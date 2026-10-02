/**
 * Type-only slice of the three Node builtins `install.test.ts` reads the
 * source tree with. skills is isomorphic (INV1: src never imports node:*) and
 * carries no `@types/node`, so the test type-check (tsconfig.test.json) gets
 * exactly the signatures that test uses, nothing wider. Vitest runs the test
 * under Node, where the real modules exist. If `@types/node` is ever added as
 * a devDependency, delete this file.
 */
/* eslint-disable no-unused-vars -- type-only declarations: core no-unused-vars
   reads the parameter names of bodiless signatures as unused variables. */

declare module 'node:fs' {
  export const readdirSync: (
    path: string,
    options: { recursive?: boolean; encoding: 'utf8' },
  ) => string[];
  export const readFileSync: (path: string, encoding: 'utf8') => string;
}

declare module 'node:path' {
  export const join: (...paths: string[]) => string;
}

declare module 'node:url' {
  export const fileURLToPath: (url: string | URL) => string;
}
