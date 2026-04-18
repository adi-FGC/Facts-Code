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
  [/^react$/,                        'React'],
  [/^react-dom$/,                    'React'],
  [/^react-router$/,                 'React Router'],
  [/^react-router-dom$/,             'React Router'],
  [/^@remix-run\//,                  'Remix'],
  [/^remix$/,                        'Remix'],
  [/^next$/,                         'Next.js'],
  [/^vite$/,                         'Vite'],
  [/^@vitejs\/plugin-/,              'Vite'],
  [/^vue$/,                          'Vue'],
  [/^@nuxt\//,                       'Nuxt'],
  [/^svelte$/,                       'Svelte'],
  [/^@sveltejs\//,                   'SvelteKit'],
  [/^solid-js$/,                     'Solid'],
  [/^astro$/,                        'Astro'],
  [/^tailwindcss$/,                  'Tailwind CSS'],
  [/^@tailwindcss\//,                'Tailwind CSS'],
  [/^turbo$/,                        'Turborepo'],
  [/^nx$/,                           'Nx'],
  [/^lerna$/,                        'Lerna'],
  [/^oxlint$/,                       'oxlint'],
  [/^oxfmt$/,                        'oxfmt'],
  [/^eslint$/,                       'ESLint'],
  [/^prettier$/,                     'Prettier'],
  [/^typescript$/,                   'TypeScript'],
  [/^vitest$/,                       'Vitest'],
  [/^jest$/,                         'Jest'],
  [/^playwright$/,                   'Playwright'],
  [/^@playwright\//,                 'Playwright'],
  [/^framer-motion$/,                'Framer Motion'],
  [/^@xyflow\//,                     'xyflow'],
  [/^zod$/,                          'Zod'],
  [/^fastapi$/i,                     'FastAPI'],
  [/^flask$/i,                       'Flask'],
  [/^django$/i,                      'Django'],
  [/^express$/,                      'Express'],
  [/^koa$/,                          'Koa'],
  [/^hono$/,                         'Hono'],
  [/^stripe$/,                       'Stripe'],
];

export function scanFrameworksFromPackageJson(text: string): FrameworkDetection {
  let pkg: Record<string, unknown>;
  try { pkg = JSON.parse(text) as Record<string, unknown>; }
  catch { return { frameworks: [], scripts: {} }; }

  const deps = Object.assign(
    {},
    (pkg.dependencies as Record<string, string>) ?? {},
    (pkg.devDependencies as Record<string, string>) ?? {},
    (pkg.peerDependencies as Record<string, string>) ?? {},
  );
  const found = new Set<string>();
  for (const name of Object.keys(deps)) {
    for (const [re, label] of DEP_TO_FRAMEWORK) {
      if (re.test(name)) { found.add(label); break; }
    }
  }
  const scripts = (pkg.scripts as Record<string, string>) ?? {};
  return { frameworks: [...found].sort(), scripts };
}

export function scanFrameworksFromRequirements(text: string): string[] {
  const found = new Set<string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim().toLowerCase();
    if (!line || line.startsWith('#')) continue;
    const name = line.split(/[=<>~!]/)[0]?.trim();
    if (!name) continue;
    for (const [re, label] of DEP_TO_FRAMEWORK) {
      if (re.test(name)) { found.add(label); break; }
    }
  }
  return [...found].sort();
}

export function mergeFrameworks(lists: Array<string[] | undefined>): string[] {
  const set = new Set<string>();
  for (const l of lists) for (const x of l ?? []) set.add(x);
  return [...set].sort();
}
