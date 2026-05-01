# UI rebuild plan — apps/ui-remix

> Snapshot of the design + architecture decisions that drove the
> `apps-remix3` editorial rebuild (commit `14b786a`). Saved for
> reference so future contributors can re-derive the choices instead
> of re-litigating them.
>
> **Companion docs**:
> - [`design_spec.md`](../../design_spec.md) — full design spec (liquid-glass, breakpoints, motion)
> - [`app_spec.md`](../../app_spec.md) — product spec (audience, use cases)
> - [`TASKS.md`](./TASKS.md) — what's ported, what's still ahead

---

## 1. Aesthetic direction (committed, not negotiable)

> **"Quarterly report meets terminal."** Editorial broadsheet typography
> with terminal-tinted data. Bloomberg Terminal redesigned by the
> Financial Times.

| Decision | Choice | Rationale |
|---|---|---|
| Display | **Fraunces** variable (optical sizing 9–144, weight 500–800) | Real editorial gravitas. Not Inter, not Geist. |
| Body sans | **Mona Sans** variable | Distinctive without precious. Avoids AI-default Inter (explicitly named in the frontend-design DON'T list). |
| Mono | **JetBrains Mono** variable + ss01/cv03 axes | Variable axis lets weight do the lifting on data. |
| Accent | **Safety orange** `oklch(64% 0.17 50)` light / `oklch(74% 0.15 50)` dark | Construction-sign hue. Says *"this is real work, look at the risk."* Never AI cyan/purple. |
| Palette | Warm-tinted OKLCH neutrals at hue 65° (light), 250° (dark) — **not inverted** | Subconscious cohesion via consistent hue bias. |
| Surfaces | **Borders only** — zero drop shadows | Drop-shadow rounded rectangles ARE the AI tell. Eliminate them. |
| Glass | Top nav (Header) ONLY | Per `design_spec.md` §2 — chrome, not content. StatusBar is NOT glass. |

### Five visual signatures

These are the things someone would remember and ask "how was this made?":

1. **Editorial label/number pairs** — `LABEL (small caps tracked)` ↘ `MONO NUMBER (expressive weight)`. Replaces "card with icon and stat."
2. **Margin column** — broadsheet marginalia on the right; key chips hang outside the body column, not inside it. Asymmetric.
3. **Sectioned tabs** — `01 OVERVIEW · 02 GRAPH · 03 DAG …` with active section's number burning safety-orange. References classified-document numbering.
4. **Footnote chips** — facts hang in the margin like printed footnotes, with a colored 2px left rule by tone (neutral / accent / warn / danger / ok).
5. **Hairline-divided columns** — vertical rules between data cells, no boxed cells. Newspaper economy.

---

## 2. Architecture

### 2.1 Token + theme

Source of truth: `packages/ui-theme/src/tokens.css`. Both light defaults
and `[data-theme='dark']` overrides live there. **Plus** a duplicated
`@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) }`
block that mirrors every dark token — so CSS-only paths (CSP-blocked,
sandboxed VS Code webview, crawlers, Lighthouse with JS off) get the
dark theme without depending on the inline script.

The user-adjustable `--fs-mult` (range 0.85–1.35) cascades through every
`clamp()` in the type scale. Initialized by the no-flash inline script
in `apps/ui-remix/index.html`.

Variable fonts loaded via Google Fonts with preconnect → preload chain.
A `Mona Sans Fallback` `@font-face` (in `styles/app.css`) is sized via
ascent/descent overrides to size-match the variable file so first paint
doesn't reflow when the real font lands.

**Lock-in flag**: switching from `[data-theme='dark']` attribute to CSS
`light-dark()` later requires a refactor of every `mix={css({...})}`
that uses `var(--*)` — possible but not free. Keep `[data-theme]` for
the foreseeable future.

### 2.2 Component model

Every component is `(handle: Handle<Props>) => (props: Props) => RemixElement`
per Remix v3's runtime. State lives in setup closures; `handle.update()`
schedules a re-render; `handle.signal` aborts on unmount. JSX flows
through `@remix-run/ui`'s automatic runtime (configured in
`vite.config.ts` and `tsconfig.json`).

Styles are `mix={css({...})}` per element. Globals in
`packages/ui-theme/src/{tokens,glass}.css` + `apps/ui-remix/src/styles/app.css`.

### 2.3 Primitive library (`apps/ui-remix/src/ui/`)

| Primitive | Responsibility |
|---|---|
| `MonoNum` | Wraps every numeric stat — tabular-nums + lining-nums + ss01/cv03 + variable weight |
| `Section` | Hairline-topped, optional label + display title + children. Replaces "card with header bar." |
| `LabelNumber` + `LabelNumberRow` | The FT/Bloomberg label/number pair pattern. Hairline-divided columns. `numberStyle` matches `MonoNum`'s feature axes exactly. |
| `RuledTable` + `RuledRow` + `RuledCell` | Hairline-divided table cells via CSS Grid. No row borders, no row backgrounds. |
| `ContentWithMargin` + `MarginColumn` | Broadsheet two-column layout. Margin collapses below 1280px via grid template change — pure CSS, no JS. |
| `FootnoteChip` | Annotation block: label + value + optional aside. Colored 2px left rule by `tone`. |
| `StatusChip` | Short colored bar + tracked uppercase mono label. No fill, no rounded box. |
| `RiskRow` | Severity bar + message + meta + optional redacted preview. Hairline-divided. |
| `Sparkline` | Inline SVG mini-chart for History only. ~50 lines, no chart lib. Justified per anti-slop rule because the series carries real meaning. |
| `NumberedNav` | Broadsheet-style tab row with classified-document numbering. Active section's number burns accent + adds underline rule. Porting tabs get a `°` footnote-style marker. |

**Lock-in flag**: `Sparkline` rendering is intentionally trivial (no
markers, no axes, no tooltips). If trends earn richer interaction,
swap to a small chart lib (`uPlot` ≈ 35 KB) — but only when there's a
specific need.

### 2.4 Layout grid

Shell template lives in `app.css`:

```css
.app-shell {
  display: grid;
  grid-template-rows:    var(--nav-h) 1fr var(--status-h);
  grid-template-columns: var(--tree-w) 1fr;
  grid-template-areas:
    "header  header"
    "tree    main"
    "footer  footer";
  height: 100dvh;
}
```

Below 900px the tree column collapses out and the grid becomes single-
column. At 4xl+ (≥3840px), `--tree-w` clamps to `min(15dvw, 600px)` so
8K monitors don't waste space.

Inside `<main>`, `ContentWithMargin` provides the two-column body grid
(`1fr var(--margin-col-w)`). Below 1280px the margin column collapses
and `MarginColumn` chips fall into the body flow.

### 2.5 Anti-slop guardrails

Active:
- **Bundle gate** — `apps/ui-remix/scripts/check-bundle-size.mjs` runs after every build. Caps: JS 150 KB raw / 50 KB gzip · CSS 24 KB raw / 8 KB gzip. Bumping the caps requires a deliberate commit. Current envelope: 101 KB JS / 31 KB gzip · 9 KB CSS / 2.6 KB gzip.
- **Glass surface restriction** — `.glass` class is reserved for chrome (currently only `Header`). Documented in `glass.css`. If a content component pulls it in, the inset meniscus + `contain: paint` collide with content sizing.
- **No `box-shadow`** anywhere outside `glass.css`. The inset meniscus is the entire shadow budget.
- **Every numeric must wrap in `MonoNum` or use a `mono`-classed element with tabular-nums.** `LabelNumber.numberStyle` is kept feature-axis aligned with `MonoNum` so both render identically.

Future (in TASKS.md):
- Stylelint rule: flag `box-shadow` outside `packages/ui-theme/src/glass.css`.
- Stylelint rule: flag `border-radius` > 8px unless selector includes `.pill`.
- Visual regression via Playwright snapshots at 390px / 1280px / 3840px.

---

## 3. Build sequence (as executed)

This is the order the rebuild landed in. Each step left the app
runnable, but the entire change shipped as a single commit because
this is a branch (`apps-remix3`), not a series of merge-to-main PRs.

1. **Token reset** — `packages/ui-theme/src/tokens.css` swapped accent + fonts + neutrals; `glass.css` lost the outer drop shadows.
2. **Font loading** — `index.html` preconnect + preload + no-flash script with `--fs-mult` init.
3. **`app.css`** — editorial shell grid + Mona Sans Fallback @font-face + accent focus ring + scrollbar tinting.
4. **Primitives** — 10 files in `src/ui/`. Each one stands alone; route components compose them.
5. **Shell** — `Header` (with `NumberedNav`), `StatusBar` (colophon strip), `TreePanel` (agate column), `PortFromLegacy` (press-release stub).
6. **Ported routes** — `Overview`, `Risks`, `History` rebuilt with primitives.
7. **Bundle gate** — `scripts/check-bundle-size.mjs` wired into `build` + `build:static`.
8. **Code review pass** — `feature-dev:code-reviewer` flagged 4 issues; 3 fixed inline (StatusBar `.glass` removed, system-pref dark CSS fallback, `MonoNum`/`LabelNumber` feature parity), 1 deferred with documented rationale.

---

## 4. What the reviewer caught

| # | Severity | Issue | Fix |
|---|---|---|---|
| 1 | Critical | `StatusBar` had `class="glass"` — colophon is content-adjacent, not chrome; `wrap` CSS already set `background: var(--bg)` collision; `contain: paint` clipped scrollbar bleed | Removed `class="glass"` |
| 2 | Critical | `prefers-color-scheme: dark` only set `color-scheme: dark` — didn't apply any dark tokens. CSP-blocked / sandboxed contexts rendered in light on dark systems | Duplicated full dark-token block under the `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) }` branch |
| 3 | Important | `NumberedNav` reads `location.pathname` directly inside the render closure | **Deferred.** Architecture intentionally re-renders the entire App on every nav event from `main.tsx` (via `popstate` + `factstack:nav` listeners that call `root.render(<App />)`). Verified working live. The reviewer's SSR concern doesn't apply since this is CSR-only by design. |
| 4 | Important | `LabelNumber.numberStyle` had `tabular-nums` but was missing the `ss01/cv03` `font-feature-settings` that `MonoNum` sets — values rendered through `value` prop got different optical treatment than values wrapped in `<MonoNum>` | Folded `fontFeatureSettings: '"ss01", "cv03"'` into `numberStyle` |

---

## 5. Tree of files this commit touched

```
apps/ui-remix/
├── index.html                      ← font preload + no-flash
├── package.json                    ← build wires bundle-size gate
├── scripts/
│   └── check-bundle-size.mjs       ← NEW: hard cap, fails CI
├── src/
│   ├── components/
│   │   ├── Header.tsx              ← brand + project chip + NumberedNav
│   │   ├── PortFromLegacy.tsx      ← press-release stub
│   │   ├── StatusBar.tsx           ← colophon (no glass)
│   │   └── TreePanel.tsx           ← agate column
│   ├── routes/
│   │   ├── History.tsx             ← rebuilt with sparklines + RuledTable
│   │   ├── Overview.tsx            ← rebuilt — the showpiece
│   │   └── Risks.tsx               ← rebuilt with RiskRow
│   ├── styles/
│   │   └── app.css                 ← shell grid + Mona Sans Fallback
│   └── ui/                         ← NEW directory, 10 primitives:
│       ├── FootnoteChip.tsx
│       ├── LabelNumber.tsx
│       ├── MarginColumn.tsx
│       ├── MonoNum.tsx
│       ├── NumberedNav.tsx
│       ├── RiskRow.tsx
│       ├── RuledColumn.tsx
│       ├── Section.tsx
│       ├── Sparkline.tsx
│       └── StatusChip.tsx
└── REBUILD_PLAN.md                 ← THIS FILE

packages/ui-theme/src/
├── glass.css                       ← inset meniscus only
└── tokens.css                      ← editorial palette + system-dark CSS fallback
```

---

## 6. Where to extend

When porting a new tab from the legacy prototype, lean on the
primitives in this order:

1. Wrap the content in `<ContentWithMargin>`. Body in column 1, optional `<MarginColumn>` in column 2.
2. Lead with the editorial kicker → `<h1>` Fraunces headline → Fraunces lede paragraph. Set the kicker to `var(--accent)`.
3. Headline figures go in `<LabelNumberRow>` with `<LabelNumber>` cells. Last cell takes `last`.
4. Body sections are `<Section>` (label + title) wrapping primitives or composed lists.
5. Lists default to ruled hairlines, NOT cards. Use `<RuledTable>` for tabular data, hand-rolled `<ul>` with `borderBottom: '1px solid var(--hairline)'` per item for prose-y lists.
6. Annotations + secondary metrics go in `<MarginColumn>` as `<FootnoteChip>` instances. Pick a `tone` deliberately.
7. Numeric stats: always `MonoNum` or pass through `LabelNumber.value`. Never raw `<span>{number}</span>`.

When in doubt: ask "would this look right printed on the cover of an
FT supplement?" If yes, ship it. If it would look at home on a generic
SaaS dashboard, reconsider.
