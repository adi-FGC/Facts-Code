// Workflow evaluator UI. Loaded as an external script so the page runs under
// `script-src 'self'` (evaluator/_headers) — no 'unsafe-inline'.
//
// Everything that comes back from /api/evaluate is MODEL OUTPUT: a manual
// scored here can carry a prompt injection that makes the model echo markup
// into a note. So no response text ever reaches innerHTML — every node is
// built with createElement / textContent (test/evaluator.test.mjs enforces
// "no innerHTML in this file"). The key stays in this tab (sessionStorage).

const DIMS = [
  'cross_project_reusability',
  'gate_enforceability',
  'self_containment',
  'verification_discipline',
  'rollback_recovery',
  'review_coverage_honesty',
  'token_operational_efficiency',
  'observability_post_deploy',
  'clarity_navigability',
  'honesty_maintainability',
];
const LABEL = {
  cross_project_reusability: 'Cross-project reuse',
  gate_enforceability: 'Gate enforcement',
  self_containment: 'Self-contained',
  verification_discipline: 'Verification',
  rollback_recovery: 'Rollback',
  review_coverage_honesty: 'Review honesty',
  token_operational_efficiency: 'Token efficiency',
  observability_post_deploy: 'Observability',
  clarity_navigability: 'Clarity',
  honesty_maintainability: 'Honesty',
};
const ROLLUPS = {
  reusable: {
    label: 'Reusable',
    dims: ['cross_project_reusability', 'self_containment', 'clarity_navigability'],
  },
  enforceable: {
    label: 'Enforceable',
    dims: [
      'gate_enforceability',
      'verification_discipline',
      'rollback_recovery',
      'observability_post_deploy',
      'token_operational_efficiency',
    ],
  },
  honest: { label: 'Honest', dims: ['review_coverage_honesty', 'honesty_maintainability'] },
};
const WORKFLOWS = [
  {
    id: 'merge',
    name: 'Hybrid merge',
    flagship: true,
    score: 0.9,
    file: 'workflows/merge.md',
    blurb:
      'Project-profile skeleton + runnable fail-closed gate scripts. Verified #1 in a blind 4-way panel.',
  },
  {
    id: 'loop',
    name: 'Auto-tinker loop',
    score: 0.82,
    file: 'workflows/loop.md',
    blurb: 'Metric-gated keep/discard loop — ships enforcement, denser to read.',
  },
  {
    id: 'claude',
    name: 'Claude-direct',
    score: 0.72,
    file: 'workflows/claude.md',
    blurb: 'Clean single-pass rewrite — reads best, but describes gates rather than shipping them.',
  },
  {
    id: 'control',
    name: 'Control (baseline)',
    score: 0.55,
    file: 'workflows/control.md',
    blurb: 'The original project-specific handoff — the before picture.',
  },
];
const RLABEL = {
  cross_project_reusability: 'Reuse',
  gate_enforceability: 'Gates',
  self_containment: 'Self-cont.',
  verification_discipline: 'Verify',
  rollback_recovery: 'Rollback',
  review_coverage_honesty: 'Rev. honesty',
  token_operational_efficiency: 'Tokens',
  observability_post_deploy: 'Observe',
  clarity_navigability: 'Clarity',
  honesty_maintainability: 'Honesty',
};
const $ = (s) => document.querySelector(s);

/** createElement with a class and children (strings become text nodes). */
function el(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
function bar(fraction, cls) {
  const fill = document.createElement('span');
  fill.style.width = Math.round(Math.max(0, Math.min(1, Number(fraction) || 0)) * 100) + '%'; // CSSOM: CSP-safe
  return el('div', cls ? 'bar ' + cls : 'bar', fill);
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function drawRadar(host, data, ref) {
  const cx = 240,
    cy = 182,
    R = 120,
    n = DIMS.length;
  const ang = (i) => ((-90 + (i * 360) / n) * Math.PI) / 180;
  const pt = (i, v) => [
    +(cx + R * v * Math.cos(ang(i))).toFixed(1),
    +(cy + R * v * Math.sin(ang(i))).toFixed(1),
  ];
  const poly = (a) => a.map((v, i) => pt(i, v).join(',')).join(' ');
  const root = svg('svg', { viewBox: '0 0 480 372', width: '100%', class: 'radar-svg' });
  for (let r = 0.2; r <= 1.001; r += 0.2)
    root.append(
      svg('polygon', {
        points: DIMS.map((_, i) => pt(i, r).join(',')).join(' '),
        fill: 'none',
        stroke: 'var(--line)',
        'stroke-width': 1,
      }),
    );
  DIMS.forEach((k, i) => {
    const [x, y] = pt(i, 1);
    root.append(
      svg('line', { x1: cx, y1: cy, x2: x, y2: y, stroke: 'var(--line)', 'stroke-width': 1 }),
    );
    const [lx, ly] = pt(i, 1.17);
    const anchor = Math.abs(lx - cx) < 10 ? 'middle' : lx > cx ? 'start' : 'end';
    const label = svg('text', {
      x: lx,
      y: ly + 3,
      'text-anchor': anchor,
      'font-size': 10,
      fill: 'var(--muted)',
    });
    label.textContent = RLABEL[k];
    root.append(label);
  });
  if (ref)
    root.append(
      svg('polygon', {
        points: poly(ref),
        fill: 'none',
        stroke: '#888780',
        'stroke-width': 1,
        'stroke-dasharray': '4 3',
      }),
    );
  root.append(
    svg('polygon', {
      points: poly(data),
      fill: 'rgba(29,158,117,.16)',
      stroke: '#1d9e75',
      'stroke-width': 2,
    }),
  );
  data.forEach((v, i) => {
    const [x, y] = pt(i, v);
    root.append(svg('circle', { cx: x, cy: y, r: 2.4, fill: '#1d9e75' }));
  });
  host.replaceChildren(root, el('div', 'legend', '▮ this workflow    ▯ flagship (merge)'));
}

// --- key: kept for this tab only (sessionStorage), and only when asked ---
const keyEl = $('#key'),
  remEl = $('#remember');
try {
  // Older builds kept the key in localStorage indefinitely; clear that copy.
  localStorage.removeItem('anthropic_key');
} catch {
  /* storage blocked — nothing to clear */
}
try {
  const k = sessionStorage.getItem('anthropic_key');
  if (k) {
    keyEl.value = k;
    remEl.checked = true;
  }
} catch {
  /* storage blocked — the key just is not remembered */
}
remEl.onchange = () => {
  try {
    if (remEl.checked) sessionStorage.setItem('anthropic_key', keyEl.value);
    else sessionStorage.removeItem('anthropic_key');
  } catch {
    /* storage blocked */
  }
};
keyEl.oninput = () => {
  if (!remEl.checked) return;
  try {
    sessionStorage.setItem('anthropic_key', keyEl.value);
  } catch {
    /* storage blocked */
  }
};

// --- workflow picker + gallery ---
const pick = $('#pick');
for (const w of WORKFLOWS) {
  const o = document.createElement('option');
  o.value = w.id;
  o.textContent = w.name + (w.flagship ? '  ★ flagship' : '') + '  (' + w.score.toFixed(2) + ')';
  pick.append(o);
}
const paste = document.createElement('option');
paste.value = '';
paste.textContent = '— paste my own —';
pick.append(paste);
$('#load').onclick = async () => {
  const w = WORKFLOWS.find((x) => x.id === pick.value);
  if (!w) return;
  setStatus('loading ' + w.name + '…');
  try {
    const t = await (await fetch(w.file)).text();
    $('#doc').value = t;
    setStatus('');
  } catch {
    setStatus('');
    showErr("Couldn't load " + w.file + ' (are you serving over http, not file://?)');
  }
};
const link = (href, label, extra) => {
  const a = el('a', 'muted', label);
  a.href = href;
  for (const [k, v] of Object.entries(extra)) a.setAttribute(k, v);
  return a;
};
for (const w of WORKFLOWS) {
  const title = el('div', null, el('h3', 'inline', w.name));
  if (w.flagship) title.append(el('span', 'badge', 'flagship'));
  title.append(el('div', 'muted', w.blurb));
  const side = el(
    'div',
    'right-nowrap',
    el('div', 's', w.score.toFixed(2)),
    link(w.file, 'download', { download: '' }),
    ' · ',
    link(w.file, 'view', { target: '_blank', rel: 'noopener' }),
  );
  $('#gallery').append(el('div', 'wf', title, side));
}

// --- leaderboard ---
WORKFLOWS.slice()
  .sort((a, b) => b.score - a.score)
  .forEach((w, i) => {
    const left = el('div', null, el('b', null, '#' + (i + 1)), ' ' + w.name);
    if (w.flagship) left.append(' ', el('span', 'badge', 'best'));
    left.append(bar(w.score, 'w220'));
    $('#board').append(el('div', 'wf', left, el('div', 's', w.score.toFixed(2))));
  });

function setStatus(t, busy) {
  $('#status').replaceChildren(...(busy ? [el('span', 'spin')] : []), text(t));
}
function showErr(t) {
  const e = $('#err');
  e.textContent = t;
  e.classList.remove('hidden');
}
function clearErr() {
  $('#err').classList.add('hidden');
}

async function call(mode) {
  clearErr();
  const apiKey = keyEl.value.trim(),
    workflow = $('#doc').value.trim(),
    model = $('#model').value.trim() || 'claude-sonnet-5';
  if (!apiKey) {
    showErr('Paste your Anthropic API key first — this tool is bring-your-own-key.');
    return null;
  }
  if (workflow.length < 50) {
    showErr('Load or paste a workflow manual (at least 50 characters).');
    return null;
  }
  setStatus(mode === 'improve' ? 'improving…' : 'evaluating…', true);
  $('#score').disabled = $('#improve').disabled = true;
  try {
    const r = await fetch('/api/evaluate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow, apiKey, mode, model }),
    });
    const j = await r.json();
    if (!r.ok) {
      showErr(text(j.error || 'Request failed') + (j.detail ? ' — ' + text(j.detail) : ''));
      return null;
    }
    return j;
  } catch (e) {
    showErr('Network error: ' + e);
    return null;
  } finally {
    setStatus('');
    $('#score').disabled = $('#improve').disabled = false;
  }
}

$('#score').onclick = async () => {
  const j = await call('score');
  if (j) renderScore(j);
};
$('#improve').onclick = async () => {
  const j = await call('improve');
  if (!j) return;
  $('#improved').classList.remove('hidden');
  $('#result').classList.remove('hidden');
  $('#impdoc').value = text(j.improved);
  $('#impchange').textContent = text(j.changelog);
  // auto re-score the improved draft to show a delta
  const prevTotal = window._lastTotal;
  const cur = $('#doc').value;
  $('#doc').value = text(j.improved) || cur;
  const s = await call('score');
  $('#doc').value = cur; // keep original in editor; improved shown separately
  if (s) {
    renderScore(s);
    if (typeof prevTotal === 'number') {
      const total = num(s.total);
      const d = total - prevTotal;
      $('#impdelta').textContent =
        '· new total ' +
        total.toFixed(3) +
        ' (was ' +
        prevTotal.toFixed(3) +
        ', Δ ' +
        ((d >= 0 ? '+' : '') + d.toFixed(3)) +
        ')';
    }
  }
};
$('#useimp').onclick = () => {
  $('#doc').value = $('#impdoc').value;
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

function renderScore(j) {
  const dims = j.dims && typeof j.dims === 'object' ? j.dims : {};
  const notes = j.notes && typeof j.notes === 'object' ? j.notes : {};
  window._lastTotal = num(j.total);
  $('#result').classList.remove('hidden');
  $('#total').textContent = num(j.total).toFixed(3);
  // rollups
  $('#rollups').replaceChildren(
    ...Object.entries(ROLLUPS).map(([k, def]) => {
      const v = j.rollups && typeof j.rollups[k] === 'number' ? j.rollups[k] : null;
      return el(
        'div',
        'stat',
        el('div', 'l', def.label),
        el('div', 'v', v == null ? '—' : v.toFixed(2)),
        bar(v ?? 0),
      );
    }),
  );
  $('#verdict').textContent = text(j.verdict);
  // per-dim table — notes are model text: textContent only
  $('#dimtable tbody').replaceChildren(
    el('tr', null, el('th', null, 'dimension'), el('th', null, 'score'), el('th', null, 'why')),
    ...DIMS.map((k) =>
      el(
        'tr',
        null,
        el('td', null, LABEL[k]),
        el('td', 'n', num(dims[k]).toFixed(2)),
        el('td', 'muted', text(notes[k])),
      ),
    ),
  );
  // radar (evaluated doc vs the flagship merge reference) — SVG built node by node
  const MERGE = [0.97, 0.95, 0.9, 0.97, 0.98, 0.97, 0.98, 0.9, 0.85, 0.92];
  drawRadar(
    $('#radar'),
    DIMS.map((k) => num(dims[k])),
    MERGE,
  );
  $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
