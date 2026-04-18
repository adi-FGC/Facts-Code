# FACTS — Animations Spec

**Version**: v0.1 draft · **Status**: Pre-scaffold · **Companion to**: `app_spec.md`, `design_spec.md`

This document answers **"how does motion work?"** — View Transition API usage, inline motion, liquid-glass choreography, fallbacks, performance budgets, and reduced-motion handling.

Reference: [MDN — View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API).

---

## 1. Motion principles

1. **Motion serves comprehension**, not decoration. A file-select transition keeps the tree node visually linked to the RHS preview — that's object permanence across the navigation, and it's what builds trust for non-developer viewers.
2. **Default durations**: ≤ 300 ms for common actions; 500 ms ceiling for signature moments.
3. **Default easings**:
   - Enter: `cubic-bezier(0.2, 0, 0, 1)`
   - Exit: `cubic-bezier(0.4, 0, 1, 1)`
   - Bidirectional emphasis: `cubic-bezier(0.34, 1.56, 0.64, 1)` (gentle overshoot).
4. **`prefers-reduced-motion: reduce` disables all non-essential motion** — replaces animated state swaps with instant ones. No `startViewTransition` calls. No specular sweeps. No blur animations. Verified in CI.
5. **Never block input for more than one frame.**
6. **Named transitions are per-element, unique per DOM, and cleaned up on unmount.**

---

## 2. View Transition API — usage catalogue

Every route-level or major-state transition goes through `document.startViewTransition()` via a shared helper in `apps/ui-remix/app/lib/view-transition.ts`.

| # | Trigger | What transitions | Named elements | Duration |
|---|---|---|---|---|
| 1 | LHS tree → file select | RHS morph-in; tree node keeps `view-transition-name: file-{hash}` | file card, breadcrumb | 220 ms |
| 2 | Graph node click | Graph shrinks to side-peek; file outline slides in | graph node, RHS pane | 280 ms |
| 3 | Tree ↔ Graph view-mode toggle | Nodes morph in place between hierarchical and force-directed positions | each node with stable id | 420 ms |
| 4 | Global tab switch | Underline slides between tabs; content crossfades | tab underline | 180 ms |
| 5 | Outline region expand/collapse | Shared-element morph between collapsed and expanded cards | symbol card | 200 ms |
| 6 | Theme swap | Circular reveal from toggle click origin; graph re-paints with dark-native palette AFTER reveal completes | `::view-transition-old(root)` / `::view-transition-new(root)` | 360 ms |
| 7 | Route navigation via Remix 3 `viewTransition` prop | Crossfade + hero morph where applicable | hero element | 220 ms |
| 8 | Mobile LHS drawer open/close | Slide + scrim fade (crossfade on scrim) | drawer, scrim | 380 ms |
| 9 | Re-analyze completes | Status bar pulses; affected tree rows flash subtly | tree rows w/ `data-changed` | 450 ms |
| 10 | ⌘K palette open/close | Glass panel scales + fades from search-button origin | palette, input | 240 ms |

---

## 3. Suspense-aware transitions (Remix 3 streaming)

Remix 3's SSR streaming + `viewTransition` prop can land a transition on a loading skeleton, then re-animate to real content — jarring.

**Solution**: `waitForSuspense()` wrapper in `apps/ui-remix/app/lib/view-transition.ts`.

```ts
// sketch
export async function transitionWithData(
  commitContent: () => void,
  opts?: { awaitSuspense?: boolean }
) {
  if (!("startViewTransition" in document)) { commitContent(); return; }
  if (opts?.awaitSuspense) await nextPaintAfterSuspense();
  document.startViewTransition(commitContent);
}
```

Used for: navigation into Files tab (data-heavy), Graph tab (graph re-layout), History tab (snapshot diff load).

---

## 4. Fallback strategy

- Feature-detect: `"startViewTransition" in document`.
- On unsupported browsers (older Safari, Firefox < 129): navigations are instant — no layout shift, no broken visuals.
- Playwright test matrix exercises **both paths** so the fallback isn't a silent regression.

---

## 5. CSS architecture

### 5.1 Global defaults

```css
::view-transition-old(root),
::view-transition-new(root) {
  animation-duration: 220ms;
  animation-timing-function: cubic-bezier(0.2, 0, 0, 1);
}
```

### 5.2 Named transitions

Named inline via `style={{ viewTransitionName: \`file-${hash}\` }}` — names must be unique per DOM at transition time. A helper hook centralizes lifecycle:

```ts
// packages/ui-theme (shared)
export function useNamedTransition(name: string) {
  // sets style, cleans up on unmount to prevent name leaks
}
```

### 5.3 Theme swap

```css
::view-transition-old(root) { animation: ft-fade-out 360ms forwards; }
::view-transition-new(root) {
  animation: ft-circle-reveal 360ms
    cubic-bezier(0.2, 0, 0, 1) forwards;
  clip-path: circle(0% at var(--theme-click-x) var(--theme-click-y));
}
```

The toggle click position is captured into CSS custom properties before calling `startViewTransition`.

---

## 6. Inline (non-View-Transition) motion

For UI that doesn't cross a route or major state boundary.

- **Library**: `framer-motion`.
- **Use cases**: LHS resize drag, tooltip reveal, hover-delay micro-interactions, progress ring on Re-analyze, sparkline draw-on.
- **Spring presets** in `packages/ui-theme/src/motion.ts`:
  - `snap`: `{ stiffness: 400, damping: 40 }`
  - `gentle`: `{ stiffness: 180, damping: 30 }`
  - `bouncy`: `{ stiffness: 200, damping: 14 }`
- Presets imported by name everywhere — never define springs inline.

---

## 7. Liquid-glass motion

### 7.1 Surface enter

```css
@keyframes glass-enter {
  from { backdrop-filter: blur(4px); opacity: 0.4; }
  to   { backdrop-filter: blur(18px); opacity: 1; }
}
.glass-surface { animation: glass-enter 180ms ease-out; }
```

### 7.2 Specular hover sweep

A 300 ms linear-gradient translate across the surface on hover. Signals interactivity without color change. One implementation in `packages/ui-theme/src/glass.css`:

```css
.glass-surface::before {
  content: "";
  position: absolute; inset: 0;
  background: linear-gradient(115deg,
    transparent 0%,
    rgba(255,255,255,0.06) 40%,
    transparent 80%);
  translate: -100% 0;
  transition: translate 300ms linear;
  pointer-events: none;
}
.glass-surface:hover::before { translate: 100% 0; }
```

### 7.3 Performance hygiene

- `will-change: backdrop-filter` only while hovered/animating, never permanently.
- `contain: paint` on every glass surface.
- On mobile (< 900 px), a feature query + UA hint disables blur animations and falls back to solid translucent backgrounds. Reason: GPU budget on phones doesn't pay for 2 ms of extra blur on every frame.

---

## 8. Graph interaction motion

| Interaction | Duration | Easing |
|---|---|---|
| Node hover scale to 1.05 | 120 ms | ease-out |
| Edge highlight (stroke-width + opacity) | 150 ms | ease-out |
| Auto-layout re-run | 400 ms | position tween with dampened overshoot |
| Node drag | no transition (direct follow) | — |
| Zoom/pan inertia | framer-motion `gentle` spring | — |

All graph animations obey `prefers-reduced-motion` — replaced with instant updates.

---

## 9. Loading & progress

- **Re-analyze**: 2 px indeterminate bar at top of shell. Becomes determinate once walker emits file count. Animated via CSS, not JS.
- **Tree skeleton**: 800 ms max before switching to empty/error state.
- **Graph layout pending**: ghost silhouettes of nodes in final positions, fading to full color as forces settle.
- **Snapshot diff load**: sparkline bars fade in one at a time, 40 ms stagger.

---

## 10. Performance budgets

- No animation blocks input for more than one frame (16 ms @ 60 fps, 8 ms @ 120 fps).
- Graph renders at 60 fps with ≤ 2 000 nodes on a MacBook Air M2.
- Frame drops in any View Transition mark the test as failed in CI.
- `will-change` applied only during active transitions and removed immediately after.
- No animation longer than 500 ms except the theme circular-reveal (360 ms is close to the ceiling).

---

## 11. Reduced-motion & reduced-transparency

### 11.1 `prefers-reduced-motion: reduce`

- `document.startViewTransition` is NOT called — state changes are instant.
- Specular sweeps, glass-enter blur animation, graph auto-layout tween, sparkline draw-on, re-analyze progress ring → all instant / static.
- Tree and graph hover effects: no scale; only color change.

### 11.2 `prefers-reduced-transparency: reduce`

- Glass surfaces become solid surface tokens.
- No blur animations.
- No specular sweeps (they rely on overlay transparency).

Both preferences are tested in CI with full navigation scripts.

---

## 12. Acceptance tests

- **Playwright + CDP frame-rate traces** on scripted navigations — assert 60 fps floor.
- **Reduced-motion run** — full nav; no `startViewTransition` call detected; no animation durations > 0 ms fired.
- **Reduced-transparency run** — glass surfaces rendered solid; no `backdrop-filter` in computed styles.
- **Responsive visual-regression snapshots** at 340, 390, 768, 1024, 1440, 1920, 2560, 3840, 7680 px for light + dark themes. Baselines committed to `examples/__screenshots__/`.
- **View Transition smoke test** — click through 20 scripted interactions; assert no unnamed transitions leaked; assert `view-transition-name` properties are cleaned up after unmount.
- **axe-core** — no motion-triggered violations (e.g., no infinite animations without user pause control).

---

## 13. Open motion questions

- Should ⌘K palette open use View Transition (#10) or pure framer-motion? Currently View Transition for visual consistency with nav — revisit if it feels heavy.
- Should Tree ↔ Graph view-mode toggle (#3) animate every node, or sample a subset on > 500-node projects to keep the transition under 420 ms? Default: sample with a deterministic hash-based pick; full morph below threshold.
- Does Remix 3's router fire `viewTransition` for programmatic navigations from inside loaders? If not, wrap manually via the helper. Verify on first route-transition build-out.
