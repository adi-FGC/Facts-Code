/**
 * TODO / FIXME / HACK / XXX / NOTE comment harvester.
 *
 * The regex is intentionally permissive — we capture the kind + whatever
 * text follows. The shipped extractor pass will filter out matches inside
 * string literals and regex bodies (which is how the prototype picks up
 * its own regex as a "TODO"). For the v0.1 CLI we accept the false
 * positives as a known limitation.
 */

import type { TodoEntry } from './types.js';

const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX|NOTE)\b[:\s]?\s*(.*)/;

export function scanTodos(text: string, limit = 50): TodoEntry[] {
  const out: TodoEntry[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i];
    if (!line) continue;
    const m = line.match(TODO_PATTERN);
    if (!m) continue;
    const kind = m[1] as TodoEntry['kind'];
    const rest = (m[2] ?? '').trim().slice(0, 200);
    out.push({ kind, line: i + 1, text: rest });
  }
  return out;
}
