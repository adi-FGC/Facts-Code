# Deploying factstack.pages.dev

Production is the Cloudflare Pages project **`factstack`** (Direct Upload; production branch
`main`). A `git push` deploys nothing. Two paths publish:

| Path                       | Who                           | What it ships                                                          |
| -------------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| `pnpm deploy:cf` (manual)  | owner, from a laptop          | a clean, pushed commit, freshly analyzed                               |
| `cve-refresh.yml` (weekly) | GitHub Actions, Mon 06:15 UTC | the commit that is **already live**, with a fresh OSV scan (data only) |

Never deploy without the owner's explicit go-ahead.

## One-time setup (owner)

- `npx --yes wrangler@4.127.1 login` (or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` with
  **Cloudflare Pages: Edit**).
- MCP sign-in config — one of:
  - `fb.mjs` (the Firebase console snippet) at the root of the **main** checkout. Builds from
    linked worktrees find it there.
  - `FACTS_FB_WEB_CONFIG` = the config as JSON (`{"apiKey":…,"projectId":…,…}`). It is public
    (it ships to every browser), so in CI it is a repository **Variable**, not a secret.
- For the weekly job: repository secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and the
  repository Variable `FACTS_FB_WEB_CONFIG`. Without them the job builds and reports but never
  publishes.

## Manual deploy

From a checkout of the commit to ship (normally `main`), clean and pushed. "Clean" counts untracked
files too, and `analyze` reads every untracked file that is not ignored, so local output folders
such as `.ag/` would be baked into the public site. Ignore them once per clone rather than forcing
the gate: `echo .ag/ >> .git/info/exclude` (from the main checkout; linked worktrees share it).
Clean the tree **before** `analyze`: the bake records the tree it was analyzed from, and
`deploy-check post` refuses a dirty one, so after committing, excluding or removing files, re-run
`analyze` and `scan-vulns`. A stash does not help: it leaves the bake analyzed from the dirty tree.

```sh
pnpm install --frozen-lockfile
node apps/cli/node_modules/tsx/dist/cli.mjs apps/cli/src/cli.ts analyze . --no-progress
node apps/cli/node_modules/tsx/dist/cli.mjs apps/cli/src/cli.ts scan-vulns .
pnpm --filter @factstack/ui-remix deploy:cf
```

`deploy:cf` runs, in order, and stops at the first failure:

| Step                                            | Fails when                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deploy-check.mjs pre`                          | uncommitted changes; HEAD on no remote branch (the weekly job could not rebuild it)                                                                                                  |
| `carry-history.mjs`                             | the live `/data/factstack.json` is unreadable or has no History (a deploy would wipe the History tab)                                                                                |
| `build:static`                                  | any build guard (CSP/header parity across hosts, one CSP per path, strict-CSP pages, privacy scan)                                                                                   |
| `gen-fb-config.mjs --require`                   | no sign-in config (the deploy would break `/mcp-auth`)                                                                                                                               |
| `deploy-check.mjs post`                         | config missing/invalid; bake or `/factstack.pack` not public; History ≤ 1 point; analyzed elsewhere, from a dirty tree, or across two analyses (`--minimal` since the last full one) |
| `wrangler@4.127.1 pages deploy … --branch main` | — always production, never a preview                                                                                                                                                 |

The bake is **public**: only the current checkout's git topology (no other worktrees, local-only
branches, unpushed commit subjects or stash count), in `/data/factstack.json` and in
`/factstack.pack`, which is re-encoded from `.facts/agent.json`. A bake from `--src` or the fixture
publishes no pack. `inject-data.mjs --full-git` exists for private local builds only.

Deliberate overrides (PowerShell: `$env:NAME = '1'`; bash: `NAME=1 pnpm …`):

- `FACTS_ALLOW_HISTORY_RESET=1` — accept a History that starts over (first deploy, or on purpose).
- `FACTS_DEPLOY_FORCE=1` — downgrade the `deploy-check pre` gates (dirty tree, unpushed HEAD) to
  warnings. Emergency hotfix only: the weekly job cannot rebuild an unpushed commit and will stop
  publishing until a normal deploy. It never relaxes `deploy-check post`, so the hotfix must still
  be committed (it may stay unpushed) and analyzed from a clean tree: a bake of uncommitted or
  untracked files never ships.

`build:static` also refuses to bake when `.facts/agent.json` is marked stale or `.facts/human.json`
comes from a newer analysis (the per-edit `analyze --minimal` hook): run a full `analyze .`.

A preview instead of production: `pnpm --filter @factstack/ui-remix build:static`, then
`npx --yes wrangler@4.127.1 pages deploy apps/ui-remix/dist --project-name factstack --branch <name>`.

## Verify (right after a deploy)

```sh
curl -sI https://factstack.pages.dev/mcp-auth | grep -ci '^content-security-policy'   # 1
curl -sI https://factstack.pages.dev/mcp-auth | grep -ci 'www\.gstatic\.com'          # 1: the scoped policy
curl -sI https://factstack.pages.dev/mcp-auth-config.json | grep -i content-type       # application/json
curl -sI https://factstack.pages.dev/review | grep -i cache-control                    # public, max-age=0, must-revalidate
curl -s  https://factstack.pages.dev/data/factstack.json | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log('history',d.history?.length,'worktrees',d.git?.worktrees?.length)"
```

Expect: one CSP on `/mcp-auth`, JSON config, `max-age=0, must-revalidate` on routes (no
stale-while-revalidate: next to must-revalidate it never applies), the previous History length + 1,
one worktree. Then open `/`, `/review` and `/mcp-auth?port=1&state=x` (the page should load the config
and only complain about the local process).

A `text/html` config means that build had no `mcp-auth-config.json`: existing files are served
before the `/*` SPA rewrite, so a missing one falls through to `index.html`. `deploy:cf` blocks
such a build (`gen-fb-config.mjs --require`); no `_redirects` exclusion is needed.

## Rollback

A Direct Upload is atomic, so a failed upload leaves the previous deployment live. To go back to
an earlier one: `npx --yes wrangler@4.127.1 pages deployment list --project-name factstack` to find
it, then Cloudflare dashboard → Workers & Pages → `factstack` → Deployments → that deployment → ⋯ →
**Rollback to this deployment**. The next weekly refresh rebuilds whatever commit is live then.

## Weekly refresh (`.github/workflows/cve-refresh.yml`)

Data-only: it reads the live bake's commit, checks that commit out (it must be on a GitHub
branch), re-analyzes, re-queries OSV, carries the live History forward (after `analyze`, whose
50-snapshot retention would otherwise drop the oldest live points), rebuilds, requires the bake to
keep every live History point (`deploy-check post --min-history`) and publishes with
`--commit-hash <live commit>`.
It never ships main's newer code; the job summary lists what main has that production does not.
It does not publish when: credentials are absent, the live History cannot be read, the live commit
cannot be checked out, or `deploy-check.mjs post` fails (usually `FACTS_FB_WEB_CONFIG` unset).

## Netlify

`factstack-demo.netlify.app` is an older mirror. It is **not** rebuilt on every push: probed
2026-09-24, it still sends the pre-2026-09-23 CSP (`https://fonts.gstatic.com` on `/*`) and bakes
data from 2026-07-06, so its last build was manual, or its builds are stopped or auto-publishing is
locked. Owner: confirm which in the Netlify dashboard (build settings and the Deploys page) before
relying on it.

When it does build, `netlify.toml` runs the same `build:static`, then
`gen-fb-config.mjs --require`, and must stay in parity with `apps/ui-remix/public/_headers`. The
site's Netlify environment needs **`FACTS_FB_WEB_CONFIG`** (the Firebase web config JSON; `fb.mjs`
is gitignored). Without it the build fails and Netlify keeps the previous deploy — it never
publishes a site whose `/mcp-auth` has no config. The MCP's default sign-in page is still this
site's `/mcp-auth.html` (`apps/mcp-server/src/auth.ts`), so a broken Netlify deploy breaks sign-in.

Netlify also applies the published `dist/_headers`, merged under `netlify.toml`: every matching
rule applies in order (file rules first) and a later value replaces an earlier one, so for the same
header `netlify.toml` wins; `! Name` lines are skipped. The generated per-route cache rules
therefore reach Netlify too, and `netlify.toml` must NOT repeat them. A path that needs its own
CSP must be keyed in `netlify.toml` below `/*` — hence its `/mcp-auth` and `/mcp-auth.html` blocks.

`apps/ui-remix/scripts/lib/netlify-headers.mjs` models this (checked against Netlify's own
`@netlify/headers-parser`), and the build fails when either host would send a wrong CSP, a route
Cache-Control other than `public, max-age=0, must-revalidate`, or a different Cache-Control/CSP from
the other host. After its next build:

```sh
curl -sI https://factstack-demo.netlify.app/review | grep -i cache-control                 # public, max-age=0, must-revalidate
curl -sI https://factstack-demo.netlify.app/mcp-auth | grep -ci '^content-security-policy' # 1
curl -sI https://factstack-demo.netlify.app/mcp-auth | grep -ci 'www\.gstatic\.com'        # 1: the scoped policy
curl -sI https://factstack-demo.netlify.app/mcp-auth-config.json | grep -i content-type    # application/json
```

Grep `www.gstatic.com` (the Firebase SDK origin), not bare `gstatic`: the stale main CSP carries
`fonts.gstatic.com`, so a bare match passes on the unfixed page.
