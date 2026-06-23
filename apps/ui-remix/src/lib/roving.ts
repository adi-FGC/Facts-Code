/**
 * Roving-tabindex keyboard model, shared by the Config radiogroups
 * (Config.tsx) and the in-view tab switchers (SubViewTabs / ViewModeToggle /
 * Flow). WAI-ARIA radiogroup + tablist both want: one tab stop for the whole
 * group (the active item, tabIndex 0; the rest tabIndex -1), and arrow keys to
 * move + activate within it.
 *
 * This module is the PURE core: given a key, the current index, and the item
 * count, it returns the next index to activate — or null when the key is not a
 * roving key (so the caller leaves the event untouched). DOM focus + selection
 * live in the component (which knows its elements + setter); keeping the index
 * math pure makes it unit-testable with no DOM.
 */

export interface RovingOptions {
  /** Which arrow keys move selection. Default 'both' (horizontal + vertical). */
  orientation?: 'horizontal' | 'vertical' | 'both';
  /** Wrap past the ends (last -> first, first -> last). Default true. */
  loop?: boolean;
}

/**
 * @returns the next index to activate, or null if `key` is not a roving key.
 * Home -> first, End -> last. ArrowRight/Down -> next, ArrowLeft/Up -> prev
 * (gated by `orientation`). A negative `current` (nothing selected) is treated
 * as 0 so the first arrow lands on a sensible neighbour.
 */
export function nextRovingIndex(
  key: string,
  current: number,
  count: number,
  options: RovingOptions = {},
): number | null {
  if (count <= 0) return null;
  const orientation = options.orientation ?? 'both';
  const loop = options.loop ?? true;
  const horizontal = orientation === 'horizontal' || orientation === 'both';
  const vertical = orientation === 'vertical' || orientation === 'both';

  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;

  let delta = 0;
  if ((horizontal && key === 'ArrowRight') || (vertical && key === 'ArrowDown')) delta = 1;
  else if ((horizontal && key === 'ArrowLeft') || (vertical && key === 'ArrowUp')) delta = -1;
  else return null;

  const start = current < 0 ? 0 : current;
  let next = start + delta;
  if (next < 0) next = loop ? count - 1 : 0;
  else if (next >= count) next = loop ? 0 : count - 1;
  return next;
}

/**
 * Roving-tabindex move for a radiogroup/tablist of <button role="…">. Computes
 * the next index for the pressed key (null = not a roving key), activates it
 * (select), and moves DOM focus to it. Returns true when it handled the key, so
 * the caller can preventDefault(). `group` is the listener element; its items
 * (role=radio|tab) are queried within it by index. Used by Config (radio) and
 * the in-view tab switchers (tab).
 */
export function moveRoving<K extends string>(
  key: string,
  group: ParentNode | null,
  items: ReadonlyArray<{ key: K }>,
  currentKey: K,
  select: (key: K) => void,
  itemRole: 'radio' | 'tab',
): boolean {
  const next = nextRovingIndex(key, items.findIndex((it) => it.key === currentKey), items.length, { loop: true });
  if (next === null) return false;
  select(items[next]!.key);
  group?.querySelectorAll<HTMLElement>(`[role="${itemRole}"]`)[next]?.focus();
  return true;
}
