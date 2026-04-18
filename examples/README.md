# examples/

Fixture projects used as golden-master tests for the FACTS analyzer. Every PR re-runs analysis across all fixtures and diffs the resulting `agent.json` against the committed baseline.

Without these, regressions would ship silently because the UI would still look fine while the underlying extraction quietly broke.

## Planned fixtures (v0.1 W2–W10)

- `react-fastapi-booking/` — small React frontend + FastAPI backend. Primary smoke fixture.
- `django-monolith/` — Django app with urls.py routing + templates.
- `nextjs-app/` — Next.js 14 with `app/` router + server actions.
- `express-api/` — Express 4 REST API with nested routers.
- `pnpm-monorepo/` — multi-package workspace; tests graph partitioning.

Each fixture ships with:
- A real (but small) codebase.
- A committed `expected/agent.json` golden file.
- A committed `expected/human.json` golden file.
- Light + dark visual-regression snapshots at 340/390/768/1024/1440/1920/2560/3840/7680 px (once `ui-remix` is running).

## Diff discipline

- Intentional schema changes require both a `packages/spec` update AND a deliberate refresh of every `expected/*.json`.
- Snapshot updates are reviewed like code.
