/** Shared lockfile fixtures for lockfiles.test.ts + vulnerabilities.test.ts. */

/** pnpm v9 monorepo: a root importer (plain, alias, catalog + peer suffix, dev)
 *  and an apps/web importer (workspace link + ws), plus a transitive minimist
 *  and a git tarball entry that must never surface as a registry package. */
export const PNPM_V9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      lodash:
        specifier: ^4.17.0
        version: 4.17.21
      string-width-cjs:
        specifier: npm:string-width@^4.2.0
        version: string-width@4.2.3
      '@scope/ui':
        specifier: 'catalog:'
        version: 1.4.0(react@18.3.1)
    devDependencies:
      vitest:
        specifier: ^2.0.0
        version: 2.1.9(@types/node@20.19.39)

  apps/web:
    dependencies:
      '@acme/core':
        specifier: workspace:*
        version: link:../../packages/core
      ws:
        specifier: ^8.0.0
        version: 8.16.0

packages:

  '@scope/ui@1.4.0':
    resolution: {integrity: sha512-aaa}
    peerDependencies:
      react: '>=18'

  lodash@4.17.21:
    resolution: {integrity: sha512-bbb}

  string-width@4.2.3:
    resolution: {integrity: sha512-ccc}
    engines: {node: '>=8'}

  vitest@2.1.9:
    resolution: {integrity: sha512-ddd}
    hasBin: true

  ws@8.16.0:
    resolution: {integrity: sha512-eee}

  minimist@1.2.5:
    resolution: {integrity: sha512-fff}

  git-dep@https://codeload.github.com/acme/git-dep/tar.gz/abc123:
    resolution: {tarball: https://codeload.github.com/acme/git-dep/tar.gz/abc123}
    version: 1.0.0

snapshots:

  '@scope/ui@1.4.0(react@18.3.1)':
    dependencies:
      react: 18.3.1
`;
