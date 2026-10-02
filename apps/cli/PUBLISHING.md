# Publishing the `factstack` CLI to npm

Owner-only. Nothing in this repo publishes automatically.

## What the build produces

`pnpm --filter @factstack/cli bundle` writes `apps/cli/publish/` (gitignored):

| Path                           | What it is                                                   |
| ------------------------------ | ------------------------------------------------------------ |
| `package.json`                 | name `factstack`, bin `factstack`, `engines.node >= 24.3.0`  |
| `dist/cli.js`                  | the CLI + every dependency, one ESM file with a shebang      |
| `dist/ui/index.html`           | the local dashboard (`ui`, `export`, `quick`)                |
| `dist/vendor/babel-parser.mjs` | served by `factstack ui` for the in-browser Open-folder scan |
| `dist/xdg-open`                | the `open` package's Linux fallback                          |
| `THIRD_PARTY_LICENSES.md`      | license text of every npm package inlined in `dist/cli.js`   |
| `README.md`                    | copy of `apps/cli/README.md`                                 |

There are no runtime `dependencies`: everything is inlined, and `node:sqlite`
is a Node built-in.

`pnpm --filter @factstack/cli pack:dry-run` rebuilds the folder and runs
`npm pack --dry-run` in it, listing exactly what would ship.

## Steps

1. **Reserve the names.** Publish (or reserve with a placeholder) `factstack`
   and `factstack-mcp` on npm, and create the `@factstack` org. Until then,
   the `npx -y factstack-mcp` MCP configs FACTS writes resolve to whoever
   owns that name. The hooks run `npm exec --no -- factstack …`, which never
   downloads, while `CLI_PUBLISHED` (packages/spec/src/launch.ts) is false;
   flipping it switches them to `npx factstack …`, so flip it only once the
   name is yours.
2. **Settle the license.** The package carries the repo's current
   `"license": "UNLICENSED"`, which tells npm users they may not use it. Set
   the real license in `apps/cli/package.json` (and add a `LICENSE` file to
   the `files` list in `scripts/bundle.mjs`) before publishing.
3. **Set the version** in `apps/cli/package.json`. `factstack --version` still
   prints the version hard-coded in `src/cli.ts` (`.version('0.1.0')`); keep
   the two in step.
4. **Update the README.** Remove the "not published to npm yet" notes from
   `apps/cli/README.md` and lead with the npm quick start.
5. **Build and check:**

   ```bash
   pnpm --filter @factstack/cli pack:dry-run
   node apps/cli/publish/dist/cli.js --version
   node apps/cli/publish/dist/cli.js doctor
   ```

   Read `apps/cli/publish/THIRD_PARTY_LICENSES.md`: every bundled package
   needs its license text there. The build copies each package's license
   file, writes the standard MIT/ISC text (with the author from its
   package.json) when a package ships none, and fails for any other
   license without a file.

   `--out <dir>` must be a new or empty folder or an earlier publish folder;
   the build refuses anything else, because it deletes the folder first.

6. **Publish** from the folder, with 2FA:

   ```bash
   cd apps/cli/publish
   npm publish --access public
   ```

7. **Afterwards:** remove the "not yet published" flags from the install
   help text and notices in `src/cli.ts`, `packages/skills` and the
   registry/docs.
