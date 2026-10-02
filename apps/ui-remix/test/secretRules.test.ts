/**
 * UI-R7 — the Credentials rule reference must name every rule the scanner
 * runs. It listed 9 of 19: generic "possible secret" rows (env-secret-pair,
 * connection-string-password, …) rendered with no reference row, and so did
 * npm / GitLab / SendGrid / Azure / Stripe-restricted / Slack-webhook hits.
 *
 * The scanner's RULES array is module-private, so its ids are read from the
 * source text (a Node-side test; the page itself never touches the scanner).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POSSIBLE_RULE_COUNT, PROVIDER_RULE_COUNT, SECRET_RULES } from '../src/lib/secretRules.ts';

const SCANNER = fileURLToPath(
  new URL('../../../packages/scanners/src/secrets.ts', import.meta.url),
);

/** Each rule's source text in the scanner's RULES array, in order (the two
 *  GitHub token shapes are two entries with one id). */
function scannerRules(): Array<{ id: string; text: string }> {
  const src = readFileSync(SCANNER, 'utf8');
  const start = src.indexOf('const RULES');
  const end = src.indexOf('\n];', start);
  expect(start, 'RULES array not found in secrets.ts').toBeGreaterThan(-1);
  /* Comments out: the note above the generic rules mentions `possible: true`. */
  const body = src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  /* Each rule's text runs from its `id:` to the next one. */
  return body
    .split(/\bid:\s*'/)
    .slice(1)
    .map((text) => ({ id: text.slice(0, text.indexOf("'")), text }));
}

/** Rule ids in the scanner's RULES array, split by the `possible: true` flag. */
function scannerRuleIds(): { provider: Set<string>; possible: Set<string> } {
  const provider = new Set<string>();
  const possible = new Set<string>();
  for (const { id, text } of scannerRules()) {
    (/\bpossible:\s*true\b/.test(text) ? possible : provider).add(id);
  }
  return { provider, possible };
}

describe('Credentials rule reference', () => {
  it('has one row per scanner rule id, generic heuristics marked possible', () => {
    const { provider, possible } = scannerRuleIds();
    expect(provider.size).toBeGreaterThan(0);
    expect(possible.size).toBeGreaterThan(0);
    const uiProvider = SECRET_RULES.filter((r) => !r.possible).map((r) => r.id);
    const uiPossible = SECRET_RULES.filter((r) => r.possible).map((r) => r.id);
    expect(new Set(uiProvider)).toEqual(provider);
    expect(new Set(uiPossible)).toEqual(possible);
    // One row per id: the two GitHub token shapes share a row.
    expect(uiProvider.length + uiPossible.length).toBe(new Set(SECRET_RULES.map((r) => r.id)).size);
  });

  it('counts provider rules and possible-secret heuristics apart', () => {
    expect(PROVIDER_RULE_COUNT + POSSIBLE_RULE_COUNT).toBe(SECRET_RULES.length);
    expect(POSSIBLE_RULE_COUNT).toBe(3);
  });

  it('never offers a rotation link for a possible secret', () => {
    for (const r of SECRET_RULES.filter((x) => x.possible)) expect(r.rotateUrl).toBeNull();
  });

  /* The card's copy is a second source of truth: pin what it quotes. */
  it('quotes each entropy gate the scanner actually sets', () => {
    const rules = scannerRules();
    let checked = 0;
    for (const row of SECRET_RULES) {
      const quoted = /entropy[^0-9]*?(\d+(?:\.\d+)?)|gate \((\d+(?:\.\d+)?)\)/i.exec(row.notes);
      if (!quoted) continue;
      const gates = rules
        .filter((r) => r.id === row.id)
        .map((r) => /\bminEntropy:\s*([\d.]+)/.exec(r.text)?.[1])
        .map(Number);
      expect(gates, `${row.id}: entropy quoted on the card`).toContain(
        Number(quoted[1] ?? quoted[2]),
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('names every secret word env-secret-pair matches (a bare *_KEY is not one)', () => {
    const text = scannerRules().find((r) => r.id === 'env-secret-pair')?.text ?? '';
    const alternation = /\(\?:((?:[A-Z_?]+\|)+[A-Z_?]+)\)/.exec(text)?.[1];
    expect(alternation, 'secret-word alternation in env-secret-pair').toBeTruthy();
    const words = alternation!.split('|').map((w) => w.replace(/\?/g, ''));
    const notes = SECRET_RULES.find((r) => r.id === 'env-secret-pair')!.notes;
    for (const w of words) expect(notes, w).toContain(w);
    expect(notes).not.toMatch(/\bor KEY\b/);
  });
});
