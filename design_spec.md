# FACTS — Design Spec

**Version**: v0.1 draft · **Status**: Pre-scaffold · **Companion to**: `app_spec.md`, `animations_spec.md`

This document answers **"what does FACTS look and feel like?"** Visuals, interaction, layout, components, theming, accessibility, and the liquid-glass aesthetic.

---

## 1. Design principles

1. **Evidence-first** — every chip, badge, and claim is clickable and resolves to its source. No unfalsifiable "health: good."
2. **Progressive depth** — the CXO lands on one screen that tells the story; the developer drills as deep as they need. The UI reveals complexity only on demand.
3. **Quiet by default** — no marketing gradients, no dense dashboards on first paint. Space and typography carry the weight before color does.
4. **Dark is first-class** — not "dark mode as an afterthought." Dark palette designed from the graph-canvas outwards, not color-inverted from light.
5. **Liquid-glass aesthetic** — modern, translucent surfaces that feel contemporary on 2026-era hardware without sliding into skeuomorphism.
6. **Fluid across scales** — 340 px on a budget Android to 8 K on a creative-director's reference monitor, the layout always makes sense.

---

## 2. Aesthetic language — liquid glass

- **Surfaces**: chrome elements (top nav, LHS panel, RHS local-tab bar, mobile drawer, tooltips, ⌘K palette, context menus) use `backdrop-filter: blur(18px)` with translucent backgrounds:
  - Light: `rgba(var(--surface-rgb), 0.62)`
  - Dark: `rgba(var(--surface-rgb), 0.48)`
- **Edges**: 1 px `inset 0 0 0 1px rgba(255,255,255,0.14)` highlight (the "glass meniscus") + a subtle bottom shadow.
- **Specular hover sweep**: a 300 ms linear-gradient translate across interactive glass surfaces on hover. Signals interactivity without color change.
- **NOT applied to**: content areas, code previews, graph canvas, and anywhere legibility > aesthetic. Glass is chrome, not content.
- **Fallback**: `@supports not (backdrop-filter: blur(1px))` → solid translucent background, no blur. No layout shift; no reduced function.
- **Performance hygiene**: `contain: paint` on all glass surfaces; mobile (< 900 px) drops blur to solid on devices flagged via UA hints or `prefers-reduced-transparency`.

See `animations_spec.md` §7 for the specular sweep motion curve.

---

## 3. Responsive system — 340 px to 8 K

### 3.1 Breakpoint table

| Name | Range | LHS behavior | Global tabs | Content |
|---|---|---|---|---|
| **xs** | 340–389 px | Hidden drawer, 82 vw | Scrollable pill row | Single column, stacked |
| **sm** | 390–639 px | Hidden drawer, 82 vw | Scrollable pill row | Single column |
| **md** | 640–899 px | Hidden drawer, 75 vw | Visible, no wrap | Single column |
| **lg** | 900–1279 px | Inline, `28dvw` default, resizable | Visible | Primary + side slide-outs |
| **xl** | 1280–1919 px | Inline, `22dvw` default, resizable | Visible + shortcut hints | Full shell |
| **2xl** | 1920–2559 px | Inline, `20dvw` default | Full, roomy | Extra right rail for context |
| **3xl (4K)** | 2560–3839 px | Inline, `18dvw` default | Full | Graph uses wider viewport; code preview splits horizontally |
| **4xl (5K–8K)** | ≥ 3840 px | Inline, `15dvw`, **capped at 600 px** | Full | **Content column capped at 1400 px**; remaining space = breathing room + secondary rails |

### 3.2 Principles

- **Clamp()** all the widths — no stepped transitions.
- **Container queries** for component-level responsiveness. A tree node renders the same whether in the LHS (narrow) or in a ⌘K result row (medium).
- **Never stretch edge-to-edge** on 4K/8K. Line lengths stay readable; extra width becomes breathing room.
- **Viewport units**: use `dvw`, `dvh`, `svh` where they shine (true dynamic viewports on mobile); Lightning CSS polyfills older Safari / tablet split-view cases.

### 3.3 Mobile LHS drawer

- 82 vw sliding drawer from the left, hamburger trigger in top nav.
- Dimmed scrim `rgba(0,0,0,0.45)` with backdrop-blur.
- Body scroll locked while open.
- Close triggers: scrim tap, Escape, back-gesture, route nav, deep-link change.
- Animation per `animations_spec.md` §2 row 8.

---

## 4. Typography

### 4.1 Stack

- **UI**: Inter (variable), fallback Geist, fallback `system-ui`.
- **Monospace**: JetBrains Mono (variable) — code previews, graph labels, token counts, bundle sizes.

### 4.2 Size scale

`12 / 13 / 14 / 16 / 20 / 24 / 32` px, mapped to `rem` from a root `font-size` the user can adjust (see 4.3). Fluid via `clamp()` at each breakpoint so 4K/8K scales up gracefully.

### 4.3 Font-size slider

- Settings panel + keyboard shortcut `⌘;`.
- Slider from **0.85× to 1.35×** multiplier on root `font-size`.
- Three discrete snap points: `Compact (0.9×) / Default (1.0×) / Large (1.15×) / Extra Large (1.3×)`.
- Free drag between snap points.
- Persisted to `localStorage` + `.facts/config.json`.
- UI re-layouts via container queries so nothing clips.
- Respects `prefers-font-size` user-agent hints where exposed.

### 4.4 Line length & rhythm

- Body content column caps at `65ch`.
- Code previews cap at `100ch`.
- 4 pt baseline grid; vertical rhythm multiples of 4 (4 / 8 / 12 / 16 / 24 / 32 / 48).

---

## 5. Color system

### 5.1 Token set

All colors live as CSS custom properties in `packages/ui-theme/src/tokens.css`. No hard-coded hex anywhere else.

Core tokens (each defined in both light and dark):
- `--fg`, `--fg-muted`, `--fg-subtle`
- `--bg`, `--surface-1`, `--surface-2`, `--surface-3`
- `--surface-glass` (with RGB variant for rgba composition)
- `--border`, `--border-strong`
- `--accent`, `--accent-fg`
- `--ok`, `--warn`, `--danger`, `--info`
- `--code-bg`, `--code-fg`
- `--graph-bg` (separate from `--bg` so graph pane can diverge)

### 5.2 Light vs dark — not inverted

Dark is tuned independently:
- `--bg` dark: `#0B0D10` (near-black with a cool tint).
- `--surface-1` dark: `#14171C`.
- `--surface-glass-rgb` dark: `20, 23, 28`.
- `--fg` dark: `#E6E8EA` (softened off-white to reduce fatigue).
- Accent remains the brand hue in both modes but desaturated ~15% in dark.
- WCAG AA minimum on text against any surface; AAA on body text.

### 5.3 Graph & tree data-viz palette

**Separate configs for light and dark — not color-inverted.**
- Dark palette tuned for OLED + low ambient light.
- Light palette tuned for daylight readability.
- Theme swap triggers a **full graph re-layout/re-paint** via the analyzer-driven render function, not just a CSS swap. Keeps cluster legibility after swap.
- Node color encodes **language** (hue).
- Status uses saturation + border.
- Churn uses opacity.
- Token cost uses **size** (area), not color — prevents palette collisions.

### 5.4 Theme toggle & no-flash

- Three-state: `Light / Dark / System`. Default System.
- Pre-paint strategy:
  1. Preferred: CSS-first. `color-scheme: light dark` + CSS `light-dark()` function, driven by a `theme` cookie set on any toggle. No JS needed before paint.
  2. Fallback: ≤ 800 byte inline `<script>` in `<head>` reads the cookie/localStorage and sets `class="theme-dark"` on `<html>`.
- Theme swap animates via View Transition API (see `animations_spec.md` §2 row 6).

---

## 6. Components

Every component documents these states: **default / hover / focus-visible / pressed / disabled / loading / empty / error**.

### 6.1 Core set
- **Tree node** — language icon · name · status chip · bundle-size badge · token-cost badge · last-modified (relative).
- **Graph node** — same metadata in a card form; hover opens preview.
- **View-mode toggle** — Tree / Graph / Split (three-segment).
- **Global tab bar** — six tabs: Overview, Graph, Files, Routes, Risks, History. Underline indicator animates between tabs (see `animations_spec.md` §2 row 4).
- **Local tab bar** — content-specific, lives on the RHS pane.
- **Status chip** — ok / broken / stale / parse_error, each with icon + color.
- **Risk row** — severity marker · rule · file:line · redacted preview · "Open file" action.
- **File preview pane** — Shiki syntax-highlighted; line-numbers; fold-regions synced with outline.
- **Re-analyze button** — turns into a determinate progress ring during analysis; disabled in static mode.
- **Theme toggle** — three-state dock in top nav.
- **Font-size slider** — in settings panel / ⌘;.
- **Mobile drawer** — sliding LHS panel, scrim, close triggers.
- **⌘K palette** — global search (files, symbols, routes, commands); glass surface; keyboard-first.
- **Glass surface** — primitive for any frosted-glass panel; takes `tone` (chrome / modal / tooltip), handles fallback.
- **Language-icon badge** — maps language id → icon; fallback generic glyph.
- **Bundle-size badge** — shows byte count, humanized (`12.3 KB`, `4.1 MB`); red above threshold.
- **Token-cost badge** — shows `tiktoken` count, humanized (`12K tok`, `1.2M tok`); warn above 200K.
- **Deep-link copy button** — copies canonical URL for the current selection.

### 6.2 Iconography

- **UI icons**: `lucide-react` (MIT, tree-shakeable).
- **Language icons**: `simple-icons` + `vscode-icons` mapper in `packages/ui-theme/src/language-icons.ts`. Keyed by language id from extractor output. Unknown languages fall back to a generic file glyph.

### 6.3 Density modes

Comfortable / Compact toggle in settings. Affects tree row height, outline spacing, graph node size.

### 6.4 Empty & error states

Every screen defines an empty state. No unexplained spinners. Examples:
- Overview on a brand-new repo: "This looks like a fresh project. Run `factstack analyze` to populate data."
- Graph with no imports: "No cross-file imports detected yet — maybe the code is all in `main.py`? Open the Files tab."
- History with one snapshot: "Run `factstack analyze` again later to see trends."

---

## 7. Layout — global shell

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Top nav (glass) — logo · GLOBAL TABS · search · theme · re-analyze       │  56 px
├──────────────────────┬────────────────────────────────────────────────────┤
│                      │  Local tab bar (glass)                             │  44 px
│   LHS panel (glass)  ├────────────────────────────────────────────────────┤
│   Tree / Graph /     │                                                    │
│   Split toggle at    │   RHS content pane                                 │
│   top of panel       │   (scrolls independently, View Transition morph    │
│                      │    on navigation)                                  │
│   22 dvw default,    │                                                    │
│   resizable, drag    │                                                    │
│   handle on edge,    │                                                    │
│   collapses to       │                                                    │
│   40 px rail         │                                                    │
│                      │                                                    │
├──────────────────────┴────────────────────────────────────────────────────┤
│  Status bar — parse state · last analysis · git branch · health summary   │  28 px
└───────────────────────────────────────────────────────────────────────────┘
```

Mobile variant: LHS hidden behind hamburger as a sliding drawer (82 vw).

---

## 8. Views in detail

### 8.1 Overview tab (landing)

Priority: a non-developer understands the project in 20 seconds.

**Sections top-to-bottom**:
1. **Project banner** — name · inferred intent (one sentence) · entry-point links · stack badges.
2. **Capabilities** — 3–5 one-liners of what the project does ("Serves HTTP API at `/api/*`", "Renders React UI for bookings", "Integrates Stripe for payments").
3. **Health headline** — e.g. "3 broken files, 47 TODOs, no secrets detected" — each clause clickable, jumps to Risks.
4. **Stack row** — language + framework icons with LOC + token-cost per.
5. **Entry points list** — routes/pages/screens, grouped by area.
6. **At-a-glance trends** — sparkline for LOC, risks, token cost over last N snapshots (if available).

### 8.2 Graph tab

- Force-directed dependency graph via `@xyflow/react`.
- Local tabs: `Dependencies | Workspaces | Cycles | Orphans`.
- Click a node → RHS splits to file outline + preview + status.
- Hover a node → inline preview card.
- Minimap in corner.
- Zoom + pan; fit-to-screen button.

### 8.3 Files tab

- LHS tree drives an RHS pane with local tabs: `Outline | Preview | Imports | Callers | TODOs | Tests`.
- Outline = collapsible regions + symbols with status chips inline.
- Preview = syntax-highlighted Shiki rendering, line-anchored deep links.
- Imports / Callers = cross-referenced lists linking to other nodes.
- TODOs = aggregated from this file.
- Tests = test files that reference this file's symbols.

### 8.4 Routes tab

- Flat list + grouped-by-area of every detected route.
- Per route: method · path · handler file · handler symbol · test coverage marker.
- Click → jumps to Files tab with that handler pre-selected.

### 8.5 Risks tab

Local tabs: `Secrets | Licenses | Broken | Stale | Supply Chain`.
- Each tab is a filter-and-table of risk rows.
- Severity indicator + rule name + file:line + redacted preview + action.
- Keyboard-first: j/k to move, Enter to open file at line.

### 8.6 History tab (scoped for v0.1)

**Primary**: a "changes since" picker — last analysis / 7 days / 30 days / custom snapshot — plus a sparkline rail for LOC, risk count, token cost, file count.

**Secondary**: clicking a changed file row opens a per-file side-by-side diff. Full tree diff is deferred to v0.2.

**Empty state**: "Run `factstack analyze` over multiple days to populate trend data."

**Storage**: `.facts/snapshots/<date>/` with content-addressed delta blobs keyed on `index.db` row hashes.

---

## 9. Accessibility

- **Keyboard**: full navigation. Visible focus rings (distinct from hover). Skip-to-content link. Escape closes panels. Global shortcuts:
  - `⌘K` — search palette.
  - `⌘B` — toggle LHS panel / drawer.
  - `⌘J` — cycle theme (Light → Dark → System).
  - `⌘;` — settings.
  - `⌘.` — command menu.
  - `j/k` — up/down in lists.
  - `/` — focus search.
- **Screen reader**: all status chips have `aria-label` with full text. Graph has a parallel list view at `/graph?view=list`. Re-analyze progress has an `aria-live` region.
- **Focus management across View Transitions**: after a tab switch, focus moves to the new content region's main heading.
- **Reduced motion**: `prefers-reduced-motion: reduce` disables View Transitions and non-essential motion. Tested in CI.
- **Reduced transparency**: `prefers-reduced-transparency: reduce` replaces glass surfaces with solid surface tokens.
- **Zoom**: layout survives 200% browser zoom without horizontal scroll.
- **Color not sole signal**: every color-coded state also carries an icon.
- **Minimum contrast**: WCAG AA, AAA for body text. Verified in CI via Playwright + axe-core.

---

## 10. Microcopy & tone

- Plain English. No jargon without a glossary link.
- Active voice. "Analyze" not "Analysis will be initiated."
- Errors state what went wrong and what to do. No stack traces in the UI.
- Numbers humanized (`12.3 KB`, `1.2M tok`, `3 min ago`).
- Dates via `Intl.DateTimeFormat` with a user preference for relative vs absolute.

---

## 11. Branding

- Wordmark: **FACTS** in a modest geometric sans — Inter Display cut or similar.
- Glyph: **evidence-mark** — a small checkmark-within-lens motif.
- Single accent hue (chosen alongside final brand palette). Desaturated for UI so it doesn't dominate data viz.
- No gradients in the wordmark; subtle gradient permitted only in marketing-site hero.

---

## 12. Print / export

- Overview tab has a `@media print` stylesheet so a CXO can PDF the dashboard.
- Everything non-essential hidden. Headline, capabilities, entry points, risks table remain.
- Print avoids glass / blur effects (flatten to solid surfaces).

---

## 13. Claude Design iteration loop

Every major view, before PR merge, passes through at least one `critique` + one `polish` skill invocation. Recommended sequence for new views:

1. `frontend-design` — first pass implementation.
2. `critique` — quality/usability feedback.
3. `arrange` + `colorize` + `typeset` — fix specific axes flagged.
4. `animate` — add purposeful motion per `animations_spec.md`.
5. `polish` — final alignment, spacing, consistency sweep.
6. `audit` — accessibility + responsive + theming check before merge.

---

## 14. Open design questions (revisit as v0.1 progresses)

- Graph visualization: stick with `@xyflow/react`, or evaluate `sigma.js` / `cytoscape.js` for larger (> 5 k node) projects?
- Should Files tab's LHS tree be the SAME component as the Files-tab global tree, or a separate file-scoped outline? (Default: shared component with a `scope` prop.)
- Command menu `⌘.` content: actions-only, or mixed actions + navigation? (Default: mixed, with section dividers.)
- Brand hue: decided alongside logo design in W10.
