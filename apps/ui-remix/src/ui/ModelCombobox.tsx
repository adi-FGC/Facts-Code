/**
 * ModelCombobox — the token panel's model picker: an editable combobox over
 * the price catalog, grouped by vendor (W3C APG "editable combobox with list
 * autocomplete"; grouped listbox).
 *
 * It replaces a native <select> whose option list the OS drew: it followed the
 * system theme rather than the app's, so with the app in dark mode on a light
 * OS the list came up white with the app's near-white text on it. Drawing the
 * list ourselves keeps it on the theme tokens in both themes, and lets the
 * reader type to narrow ~25 models instead of scrolling them.
 *
 * Keyboard (focus never leaves the input; the active option is virtual, via
 * aria-activedescendant):
 *   ↓ / ↑        open the list, then move through it (wrapping)
 *   Alt+↓        open without moving
 *   typing       filters by name, vendor, API id or price
 *   Enter        choose the active model
 *   Esc / Tab    close, keeping the current model
 *
 * CSP: no style= anywhere; the list hangs off a position:relative wrapper.
 */
import type { Handle } from 'remix/ui';
import { css, on, ref } from 'remix/ui';
import type { CatalogModel } from '../lib/modelCatalog.ts';
import {
  flatModels,
  modelDisplayText,
  modelPriceText,
  searchModels,
  stepId,
  type PriceOf,
} from '../lib/modelSearch.ts';

export interface ModelComboboxProps {
  models: readonly CatalogModel[];
  /** The chosen model's id. */
  value: string;
  onSelect: (id: string) => void;
  /** Accessible name of the input. */
  label: string;
  /** The input rate to show per model; the baked catalog rate if omitted.
   *  The token panel passes the rate in force, so the box agrees with the
   *  rate card once live prices are loaded. */
  priceOf?: PriceOf;
}

/* ─────────── styles ─────────── */

const root = css({
  position: 'relative',
  display: 'inline-flex',
  minWidth: '0',
});

const field = css({
  display: 'flex',
  alignItems: 'stretch',
  height: '28px',
  width: '17rem',
  maxWidth: '100%',
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  '&:focus-within': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
});

const input = css({
  flex: '1 1 auto',
  minWidth: '0',
  border: '0',
  background: 'transparent',
  color: 'var(--fg)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.06em',
  paddingInline: 'var(--space-2)',
  textOverflow: 'ellipsis',
  cursor: 'pointer',
  /* The ring is drawn on the field, around the input and the chevron. */
  '&:focus': { outline: 'none', cursor: 'text' },
  '&::placeholder': { color: 'var(--fg-faint)' },
});

const chevron = css({
  flex: '0 0 auto',
  width: '26px',
  border: '0',
  borderLeft: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--fg-muted)',
  fontSize: 'var(--fs-10)',
  lineHeight: '1',
  cursor: 'pointer',
  '&:hover': { color: 'var(--accent)', background: 'var(--accent-soft)' },
});

const popup = css({
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: '0',
  zIndex: '20',
  width: 'min(24rem, calc(100vw - 32px))',
  background: 'var(--surface-1)',
  border: '1px solid var(--hairline)',
  boxShadow: '0 12px 28px -14px color-mix(in oklab, black 55%, transparent)',
});

const list = css({
  maxHeight: 'min(22rem, 60vh)',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  paddingBlock: 'var(--space-1)',
});

const groupHead = css({
  paddingInline: 'var(--space-3)',
  paddingTop: 'var(--space-3)',
  paddingBottom: 'var(--space-1)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

const option = css({
  display: 'grid',
  gridTemplateColumns: '1.1em minmax(0, 1fr) auto',
  alignItems: 'baseline',
  columnGap: 'var(--space-2)',
  paddingInline: 'var(--space-3)',
  paddingBlock: '6px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg)',
  cursor: 'pointer',
});

const optionActive = css({
  background: 'var(--highlight-soft)',
  boxShadow: 'inset 2px 0 0 0 var(--accent)',
});

const check = css({ color: 'var(--accent)' });

const optLabel = css({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const optPrice = css({
  color: 'var(--fg-muted)',
  fontVariantNumeric: 'tabular-nums',
});

const optNoPrice = css({ color: 'var(--fg-faint)' });

const empty = css({
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-4)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg-muted)',
});

/* ─────────── component ─────────── */

/* Ids are per instance: two pickers on one page must not share option ids. */
let instances = 0;

export function ModelCombobox(handle: Handle<ModelComboboxProps>) {
  const uid = `model-cb-${++instances}`;
  const listId = `${uid}-list`;
  const optionId = (modelId: string) => `${uid}-opt-${modelId}`;

  let open = false;
  /** null until the reader types: the list then shows every model. */
  let query: string | null = null;
  let activeId: string | null = null;
  let inputEl: HTMLInputElement | null = null;
  let rootEl: HTMLElement | null = null;

  const current = (): CatalogModel | undefined =>
    handle.props.models.find((m) => m.id === handle.props.value);

  const shown = () =>
    flatModels(searchModels(handle.props.models, query ?? '', handle.props.priceOf));

  /** After the render: keep the active option visible inside the list. */
  function revealActive() {
    if (!activeId) return;
    document.getElementById(optionId(activeId))?.scrollIntoView({ block: 'nearest' });
  }

  function openList(move: 0 | 1 | -1 = 0) {
    const firstOpen = !open;
    if (firstOpen) {
      open = true;
      query = null;
      activeId = handle.props.value;
    }
    if (move !== 0)
      activeId = stepId(
        shown().map((m) => m.id),
        firstOpen ? null : activeId,
        move,
      );
    void handle.update().then(() => {
      // Opening shows the whole chosen label selected, so typing replaces it.
      if (firstOpen) inputEl?.select();
      revealActive();
    });
  }

  function close() {
    if (!open) return;
    open = false;
    query = null;
    activeId = null;
    void handle.update();
  }

  function choose(id: string) {
    open = false;
    query = null;
    activeId = null;
    if (id !== handle.props.value) handle.props.onSelect(id);
    void handle.update();
  }

  function onKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (e.altKey) openList(0);
        else openList(open ? 1 : 0);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (open) openList(-1);
        else openList(0);
        return;
      case 'Enter':
        if (!open) return;
        e.preventDefault();
        if (activeId && shown().some((m) => m.id === activeId)) choose(activeId);
        return;
      case 'Escape':
        if (!open) return;
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case 'Tab':
        close();
        return;
    }
  }

  function onInput(value: string) {
    open = true;
    query = value;
    // The best guess is the first match; the reader can arrow from there.
    activeId = shown()[0]?.id ?? null;
    void handle.update().then(revealActive);
  }

  return () => {
    const { models, value, label, priceOf } = handle.props;
    const chosen = current();
    const groups = open ? searchModels(models, query ?? '', priceOf) : [];
    const count = flatModels(groups).length;
    const expanded = open && count > 0;
    const inputValue =
      open && query !== null ? query : chosen ? modelDisplayText(chosen, priceOf) : '';

    return (
      <div
        mix={[
          root,
          ref<HTMLDivElement>((node) => {
            rootEl = node;
          }),
          /* Close when focus leaves the widget, not when it moves between
             the input and the chevron. */
          on<HTMLDivElement, 'focusout'>('focusout', (e) => {
            const next = e.relatedTarget;
            if (!(next instanceof Node) || !rootEl?.contains(next)) close();
          }),
        ]}
      >
        <div mix={field}>
          <input
            type="text"
            role="combobox"
            value={inputValue}
            placeholder="Search models…"
            aria-label={label}
            aria-autocomplete="list"
            aria-expanded={expanded ? 'true' : 'false'}
            aria-controls={expanded ? listId : undefined}
            aria-activedescendant={expanded && activeId ? optionId(activeId) : undefined}
            autocomplete="off"
            spellcheck={false}
            mix={[
              input,
              ref<HTMLInputElement>((node) => {
                inputEl = node;
              }),
              on<HTMLInputElement, 'keydown'>('keydown', onKeyDown),
              on<HTMLInputElement, 'input'>('input', (e) => onInput(e.currentTarget.value)),
              on<HTMLInputElement, 'click'>('click', () => {
                if (!open) openList(0);
              }),
            ]}
          />
          <button
            type="button"
            tabindex={-1}
            aria-label={open ? 'Close the model list' : 'Show all models'}
            mix={[
              chevron,
              // Keep focus in the input; the button only toggles.
              on<HTMLButtonElement, 'mousedown'>('mousedown', (e) => e.preventDefault()),
              on<HTMLButtonElement, 'click'>('click', () => {
                if (open) close();
                else {
                  inputEl?.focus();
                  openList(0);
                }
              }),
            ]}
          >
            {open ? '▴' : '▾'}
          </button>
        </div>

        {open && (
          <div mix={popup}>
            {count === 0 ? (
              <div mix={empty}>No model matches “{query}”.</div>
            ) : (
              <div id={listId} role="listbox" aria-label="Models" mix={list}>
                {groups.map((g, gi) => (
                  <div key={g.vendor} role="group" aria-labelledby={`${uid}-g${gi}`}>
                    <div id={`${uid}-g${gi}`} role="presentation" mix={groupHead}>
                      {g.vendor}
                    </div>
                    {g.models.map((m) => {
                      const isActive = m.id === activeId;
                      const priced = typeof (priceOf ? priceOf(m) : m.inputPerMTok) === 'number';
                      return (
                        <div
                          key={m.id}
                          id={optionId(m.id)}
                          role="option"
                          aria-selected={isActive ? 'true' : 'false'}
                          mix={[
                            option,
                            isActive ? optionActive : null,
                            on<HTMLDivElement, 'mousedown'>('mousedown', (e) => e.preventDefault()),
                            on<HTMLDivElement, 'mousemove'>('mousemove', () => {
                              if (activeId === m.id) return;
                              activeId = m.id;
                              void handle.update();
                            }),
                            on<HTMLDivElement, 'click'>('click', () => choose(m.id)),
                          ]}
                        >
                          <span mix={check} aria-hidden="true">
                            {m.id === value ? '✓' : ''}
                          </span>
                          <span mix={optLabel}>{m.label}</span>
                          <span mix={[optPrice, priced ? null : optNoPrice]}>
                            {modelPriceText(m, priceOf)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
            <div class="sr-only" role="status" aria-live="polite">
              {count === 1 ? '1 model' : `${count} models`}
            </div>
          </div>
        )}
      </div>
    );
  };
}
