// Cloudflare Pages Function — POST /api/evaluate
// BYOK live evaluator: forwards the caller's own Anthropic API key to api.anthropic.com,
// scores/improves a build->review->ship workflow manual against the fixed rubric, and returns
// structured JSON. It is STATELESS: the key is never stored, logged, or persisted — it is used
// only to make the one upstream request on the caller's behalf. Source is public; verify it.

const WEIGHTS = {
  cross_project_reusability: 0.16, gate_enforceability: 0.16, self_containment: 0.12,
  verification_discipline: 0.12, rollback_recovery: 0.10, review_coverage_honesty: 0.10,
  token_operational_efficiency: 0.10, observability_post_deploy: 0.06,
  clarity_navigability: 0.04, honesty_maintainability: 0.04,
};
// The three headline rollups ("all 3 things"): each is the renormalized weighted mean of its dims.
const ROLLUPS = {
  reusable: ["cross_project_reusability", "self_containment", "clarity_navigability"],
  enforceable: ["gate_enforceability", "verification_discipline", "rollback_recovery",
                "observability_post_deploy", "token_operational_efficiency"],
  honest: ["review_coverage_honesty", "honesty_maintainability"],
};
const DIMS = Object.keys(WEIGHTS);

const RUBRIC_TEXT = `Score a build->review->ship operating manual on how good it is AS A REUSABLE,
CROSS-PROJECT artifact a fresh agent session can run UNATTENDED. Each dimension 0.0-1.0.
Anchor bands: 0.0 absent/misleading; 0.25 present-but-prose-only/weak; 0.5 adequate; 0.75 strong; 1.0 exemplary+verifiable.
Rules: score ONLY what is in the text; a gate that READS as hard but rests on prose/session-memory scores LOW on
gate_enforceability however emphatic; penalize over-claims and stale/unverifiable assertions; reward mechanisms that
survive a fresh session with zero prior context.
Dimensions (key — what it measures):
- cross_project_reusability: project-agnostic; specifics isolated into a profile/placeholders vs hardcoded.
- gate_enforceability: gates enforced by a runnable check that fails closed vs honor-system prose; bypass paths closed/machine-checked.
- self_containment: a fresh zero-context session can execute every step from the doc alone.
- verification_discipline: findings need a regression test + proof-of-flip; claims are verifiable; no stale facts asserted as constants.
- rollback_recovery: rollback covers code AND schema AND already-applied DATA/backfills; reversible.
- review_coverage_honesty: layered review, each layer's blind spot named; no coverage over-claim.
- token_operational_efficiency: cheap-context tooling + orchestration with concurrency caps / rate-limit handling / structured returns.
- observability_post_deploy: post-deploy checks target the NEW artifact (not the previous deploy); alerting.
- clarity_navigability: skimmable, right altitude, indexed; a hurried session finds what it needs.
- honesty_maintainability: unimplemented things marked TODO not asserted-as-done; realistic maintenance; no over-claims.`;

const SCORE_SYS =
  "You are a STRICT, BLIND evaluator of build->review->ship workflow operating manuals. You judge the artifact " +
  "alone. Respond with ONLY a single JSON object, no prose, no markdown fences.";

function scorePrompt(workflow) {
  return `${RUBRIC_TEXT}

Return ONLY this JSON (all ten dims required, each 0.0-1.0):
{"dims":{${DIMS.map((d) => `"${d}":<0..1>`).join(",")}},
 "notes":{${DIMS.map((d) => `"${d}":"<=18 words"`).join(",")}},
 "verdict":"one honest paragraph: is it reusable, does it actually enforce (or just describe), is it honest?",
 "strongest":"<dim key>","weakest":"<dim key>"}

=== WORKFLOW MANUAL TO SCORE ===
${workflow}
=== END ===`;
}

const IMPROVE_SYS =
  "You improve build->review->ship workflow operating manuals to maximize the rubric while staying honest " +
  "(never delete a true caveat to game a score). Respond with ONLY a single JSON object, no prose, no fences.";

function improvePrompt(workflow) {
  return `${RUBRIC_TEXT}

Improve the manual below to raise the weighted rubric score — especially its WEAKEST dimensions — WITHOUT regressing
others and WITHOUT over-claiming. Prefer converting prose gates into runnable fail-closed checks and isolating
project-specifics into a profile. Return ONLY this JSON:
{"improved":"<the COMPLETE revised manual in markdown>","changelog":"<what changed + which dims it targets>"}

=== WORKFLOW MANUAL TO IMPROVE ===
${workflow}
=== END ===`;
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors() },
  });
}
function clamp01(x) {
  x = Number(x);
  if (!isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function extractJson(text) {
  // tolerate stray prose or ```json fences around the object
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/,"");
  try { return JSON.parse(t); } catch {}
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} }
  return null;
}
function rollupScores(dims) {
  const out = {};
  for (const [name, keys] of Object.entries(ROLLUPS)) {
    let ws = 0, acc = 0;
    for (const k of keys) { ws += WEIGHTS[k]; acc += WEIGHTS[k] * clamp01(dims[k]); }
    out[name] = ws ? +(acc / ws).toFixed(4) : null;
  }
  return out;
}
function weightedTotal(dims) {
  let acc = 0;
  for (const k of DIMS) acc += WEIGHTS[k] * clamp01(dims[k]);
  return +acc.toFixed(4);
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors() });
}

export async function onRequestPost(context) {
  let body;
  try { body = await context.request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const workflow = (body.workflow || "").toString();
  const apiKey = (body.apiKey || "").toString().trim();
  const mode = body.mode === "improve" ? "improve" : "score";
  const model = (body.model || "claude-sonnet-5").toString().trim();

  if (!apiKey) return json({ error: "Missing apiKey — this tool is bring-your-own-key. Paste your own Anthropic API key." }, 400);
  if (workflow.length < 50) return json({ error: "Provide a workflow manual of at least 50 characters." }, 400);
  if (workflow.length > 60000) return json({ error: "Workflow too long (max 60,000 characters)." }, 413);

  const sys = mode === "improve" ? IMPROVE_SYS : SCORE_SYS;
  const prompt = mode === "improve" ? improvePrompt(workflow) : scorePrompt(workflow);

  let up;
  try {
    up = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,                 // BYOK: caller's key, forwarded once, never stored
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: mode === "improve" ? 8000 : 1600,
        temperature: 0,
        system: sys,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (e) {
    return json({ error: "Could not reach the Anthropic API.", detail: String(e).slice(0, 200) }, 502);
  }
  if (!up.ok) {
    const t = await up.text();
    return json({ error: `Anthropic API returned ${up.status}. Check your key/model.`, detail: t.slice(0, 500) }, up.status);
  }
  const data = await up.json();
  const text = (data.content || []).map((c) => c.text || "").join("");
  const parsed = extractJson(text);
  if (!parsed) return json({ error: "Model did not return valid JSON.", raw: text.slice(0, 800) }, 502);

  if (mode === "improve") {
    return json({ mode, model, improved: parsed.improved || "", changelog: parsed.changelog || "" });
  }
  // score mode: recompute total + rollups server-side from the dims (deterministic, no LLM arithmetic)
  const dims = {};
  for (const k of DIMS) dims[k] = clamp01((parsed.dims || {})[k]);
  return json({
    mode, model,
    dims,
    notes: parsed.notes || {},
    total: weightedTotal(dims),
    rollups: rollupScores(dims),
    verdict: parsed.verdict || "",
    strongest: parsed.strongest || "",
    weakest: parsed.weakest || "",
  });
}
