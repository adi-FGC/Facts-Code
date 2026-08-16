# Workflow Evaluator — a BYOK live scorer for build→review→ship manuals

A self-contained static site + one Cloudflare Pages Function. It scores any workflow manual on three
things — **reusable · enforceable · honest** — using a fixed 10-dimension rubric, and can run one
improve pass. Browse + download the open, verified workflows (the flagship is the hybrid merge).

## Why it's a SIBLING Pages project (not on factstack.pages.dev directly)
`factstack.pages.dev` is the Remix-v3 SPA at `apps/ui-remix/` with a strict, byte-equal-guarded CSP
(no inline scripts/styles, no external CDNs, an SRI-pinned boot script) that is mid-rebuild. Dropping
an inline BYOK page onto that deploy would be CSP-blocked and would disturb in-progress work. So this
ships as its own additive Pages project in the same repo/account, linkable from the main site. It has
**zero external dependencies** (the radar is hand-rolled SVG) and its own tight CSP (`_headers`).

## Bring-your-own-key trust model
- The visitor pastes **their own** Anthropic API key. The `functions/api/evaluate.js` Worker forwards
  it **once** to `api.anthropic.com` and returns the result. It is **never stored, logged, or
  persisted** — read the source, it's ~150 lines. Optionally the browser remembers the key in
  `localStorage` (this device only), off by default.
- No cost or abuse exposure for the project owner: every call runs on the visitor's own key.

## Files
- `index.html` — the whole UI (browse, score, radar, improve, leaderboard). No build step.
- `functions/api/evaluate.js` — the BYOK Pages Function (`POST /api/evaluate`, modes `score`/`improve`).
- `workflows/*.md` — the four manuals (merge=flagship, loop, claude, control).
- `rubric.json` — the 10-dimension ruler. `_headers` — CSP + security headers.

## Deploy (do NOT run without an explicit go-ahead)
From this directory, with Cloudflare creds (`wrangler login`, or `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` with Pages:Edit):

```sh
npx --yes wrangler@4 pages deploy . --project-name factstack-evaluator
```

This creates/updates `factstack-evaluator.pages.dev` — a NEW project, leaving `factstack.pages.dev`
untouched. Cloudflare Pages auto-discovers the co-located `functions/` dir, so `/api/evaluate` works
with no extra config. Add `--branch main` to force a production (not preview) deploy.

## Local test
```sh
npx --yes wrangler@4 pages dev .        # serves the static site AND the Function at /api/evaluate
```
Then open the printed localhost URL, paste your key, and Evaluate. (A plain static server serves the
UI but not the Function.)

## How it "improves with time"
The four manuals + the leaderboard are the output of the local auto-tinker A/B/C experiment. Each time
the loop re-runs locally and produces a better best, regenerate these files and redeploy — the
published flagship + scores update. Verified offline, then published.
