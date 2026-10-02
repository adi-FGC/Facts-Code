/**
 * Framework / tooling detection from manifest files.
 *
 * Reads package.json (JS/TS ecosystem) and pyproject.toml / requirements.txt
 * (Python) where available. Returns a sorted, deduplicated list of human
 * names. The shipped analyzer will also cross-check import signatures in
 * source to improve precision.
 */

export interface FrameworkDetection {
  frameworks: string[];
  scripts: Record<string, string>;
}

/** Known dependency → framework-name map. Order wins: first hit per package. */
const DEP_TO_FRAMEWORK: Array<[RegExp, string]> = [
  [/^react$/, 'React'],
  [/^react-dom$/, 'React'],
  [/^react-router$/, 'React Router'],
  [/^react-router-dom$/, 'React Router'],
  [/^@remix-run\//, 'Remix'],
  [/^remix$/, 'Remix'],
  [/^next$/, 'Next.js'],
  [/^vite$/, 'Vite'],
  [/^@vitejs\/plugin-/, 'Vite'],
  [/^vue$/, 'Vue'],
  [/^@nuxt\//, 'Nuxt'],
  [/^svelte$/, 'Svelte'],
  [/^@sveltejs\//, 'SvelteKit'],
  [/^solid-js$/, 'Solid'],
  [/^astro$/, 'Astro'],
  [/^tailwindcss$/, 'Tailwind CSS'],
  [/^@tailwindcss\//, 'Tailwind CSS'],
  [/^turbo$/, 'Turborepo'],
  [/^nx$/, 'Nx'],
  [/^lerna$/, 'Lerna'],
  [/^oxlint$/, 'oxlint'],
  [/^oxfmt$/, 'oxfmt'],
  [/^eslint$/, 'ESLint'],
  [/^prettier$/, 'Prettier'],
  [/^typescript$/, 'TypeScript'],
  [/^vitest$/, 'Vitest'],
  [/^jest$/, 'Jest'],
  [/^playwright$/, 'Playwright'],
  [/^@playwright\//, 'Playwright'],
  [/^framer-motion$/, 'Framer Motion'],
  [/^@xyflow\//, 'xyflow'],
  [/^zod$/, 'Zod'],
  [/^fastapi$/i, 'FastAPI'],
  [/^flask$/i, 'Flask'],
  [/^django$/i, 'Django'],
  [/^express$/, 'Express'],
  [/^koa$/, 'Koa'],
  [/^hono$/, 'Hono'],
  [/^stripe$/, 'Stripe'],
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function scanFrameworksFromPackageJson(text: string): FrameworkDetection {
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return { frameworks: [], scripts: {} };
  }
  /* Valid JSON is not always a package object: fixture and parser-test repos
     ship `null`, `[]` or `"x"` package.json files, and one of them must never
     abort the whole analyze (it threw on `null.dependencies`). */
  if (!isRecord(pkg)) return { frameworks: [], scripts: {} };

  const found = new Set<string>();
  for (const field of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
    if (!isRecord(field)) continue;
    for (const name of Object.keys(field)) {
      for (const [re, label] of DEP_TO_FRAMEWORK) {
        if (re.test(name)) {
          found.add(label);
          break;
        }
      }
    }
  }
  const scripts: Record<string, string> = {};
  if (isRecord(pkg.scripts)) {
    for (const [k, v] of Object.entries(pkg.scripts)) if (typeof v === 'string') scripts[k] = v;
  }
  return { frameworks: [...found].sort(), scripts };
}

export function scanFrameworksFromRequirements(text: string): string[] {
  const found = new Set<string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim().toLowerCase();
    // Comments and pip options (`-r base.txt`, `-e …`, `--hash=…`).
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    // The name ends at extras `[…]`, a version operator, an env marker `;`,
    // whitespace, or a direct-URL `@`.
    const name = line.split(/[[=<>~!;\s@]/)[0]?.trim();
    if (!name) continue;
    for (const [re, label] of DEP_TO_FRAMEWORK) {
      if (re.test(name)) {
        found.add(label);
        break;
      }
    }
  }
  return [...found].sort();
}

export function mergeFrameworks(lists: Array<string[] | undefined>): string[] {
  const set = new Set<string>();
  for (const l of lists) for (const x of l ?? []) set.add(x);
  return [...set].sort();
}
