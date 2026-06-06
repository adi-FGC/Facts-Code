# Context Packing & Token-Reduction — Market Dossier

> CIO market-landscape scan · captured 2026-06-06 · part of the FACTS competitive landscape (see [`./index.html`](./index.html) and [`../index.html`](../index.html)).
> Research method: live web + GitHub. Figures are point-in-time; "~"/"verify" flags uncertainty.

Tools whose job is to turn a codebase or large context into a token-efficient payload for LLMs — repo flatteners, AST skeletonizers, and prompt/context compressors.

---

## Repo-flatten / codebase-to-prompt

### Repomix — yamadashy/repomix [open-source MIT]
- **One-liner:** De-facto standard CLI for packing a whole repo into a single AI-ready file, with tree-sitter code compression and an MCP server.
- **Method tags:** repo-flatten, AST-aware, gitignore-respect, token-count, MCP-server, secret-scan, multi-format
- **Key features:** four outputs (XML default/Claude-optimized, Markdown, JSON, plain); tree-sitter "compress" strips bodies, keeps signatures (~70% token cut claimed); per-file + aggregate token counts; Secretlint guard; MCP mode for agents; web UI at repomix.com.
- **Methodology:** dir walk respecting `.gitignore` + `repomix.config.json`; optional tree-sitter AST pass extracts signatures only; wraps in XML `<file>` tags; comment/blank-line stripping toggles; tiktoken-compatible counting.
- **Token mechanism:** AST skeleton (~70% reduction) + XML tags improve LLM parse recall.
- **Traction:** ~26,000★ (actively maintained). **Openness:** MIT. **Limit:** full-repo flatten with no query-aware relevance ranking.

### gitingest — cyclotruc/gitingest [open-source MIT]
- **One-liner:** Swap "hub"→"ingest" in any GitHub URL for an instant prompt-friendly text digest.
- **Method tags:** repo-flatten, gitignore-respect, web-service, URL-shortcut, token-count
- **Key features:** zero-install URL swap; Python CLI; MCP variant (`adhikasp/mcp-git-ingest`); dir tree + file blocks; token estimate.
- **Methodology:** clone/read → tree header + flat content blocks; gitignore + include/exclude; plain text (not XML); no AST.
- **Token mechanism:** none beyond filtering. **Traction:** ~14,800★. **Openness:** MIT. **Limit:** no AST compression, no prioritization, no budget.

### code2prompt — mufeedvh/code2prompt [open-source MIT]
- **One-liner:** Rust CLI + Python lib + MCP server converting a codebase into a templated prompt (Handlebars, TUI, multi-tokenizer).
- **Method tags:** repo-flatten, template-engine, AST-aware, token-count, MCP-server, TUI, multi-tokenizer
- **Key features:** Handlebars templates (review/doc/bug); interactive TUI selection; multiple tokenizers (tiktoken, HF); git-diff mode; MCP server.
- **Methodology:** tree walk + gitignore/glob; metadata into template slots; optional Rust tree-sitter structure extraction.
- **Token mechanism:** template-driven selective inclusion + optional AST skeleton. **Traction:** ~7,400★. **Openness:** MIT. **Limit:** config overhead; no auto relevance ranking.

### files-to-prompt — simonw/files-to-prompt [open-source Apache-2.0]
- **One-liner:** Minimal Unix-philosophy tool to pipe a directory into one prompt (Claude XML or Markdown).
- **Method tags:** repo-flatten, gitignore-respect, pipe-friendly, XML-output, minimal
- **Key features:** `--cxml` Claude `<documents>` wrapper; stdin/stdout composable with the `llm` CLI; gitignore-respect; `--ignore`/`--extension`; line-number option.
- **Methodology:** pure concatenation with path headers; no AST/compression; composes with Simon's `llm`.
- **Token mechanism:** none (filtering only). **Traction:** ~2,750★. **Openness:** Apache-2.0. **Limit:** intentionally minimal — no token count, compression, web UI, or MCP.

### yek — bodo-run/yek [open-source MIT]
- **One-liner:** Rust serializer that uses git history to priority-rank files and streams only the most important content within a token budget.
- **Method tags:** repo-flatten, git-history-priority, token-budget, streaming, gitignore-respect, speed
- **Key features:** git recency/frequency ranking; `--tokens`/`--max-size` greedy budget fill; ~230× faster than Repomix on Next.js (claimed); pipe-aware streaming; `yek.yaml`; per-dir weights.
- **Methodology:** score files from `git log` frequency+recency → sort → greedily pack within budget → path-annotated blocks; no AST.
- **Token mechanism:** budget cap + git-history ranking fill the window with most-worked-on code. **Traction:** ~2,450★. **Openness:** MIT. **Limit:** git signal is a proxy; not query-semantic.

### RepoPrompt — repoprompt.com [proprietary / freemium]
- **One-liner:** macOS "Context IDE" that curates token-efficient prompts via CodeMaps, line slices, and multi-agent orchestration.
- **Method tags:** AST-aware, token-budget, query-driven-selection, MCP-server, GUI, multi-agent
- **Key features:** CodeMaps (AST symbol skeleton without full bodies); auto Context Builder from a task description; 15+ token-efficient MCP tools; line-slice mode for big files; native Mac multi-agent UI.
- **Methodology:** task → semantic file relevance scoring → ranked list within budget; CodeMaps = AST symbol index; line slicing; MCP for dynamic re-fetch.
- **Token mechanism:** budget-aware selection + CodeMaps replace bodies with symbol skeletons; query-driven (only relevant files). **Traction:** verify. **Openness:** freemium ($14.99/mo Pro). **Limit:** macOS-only, closed, no documented headless/CI.

### uithub — janwilmake [open-core / SaaS]
- **One-liner:** URL-swap service (github→uithub) delivering full repo context with API + MCP server.
- **Method tags:** repo-flatten, URL-shortcut, web-service, MCP-server, API
- **Key features:** one-letter URL change; REST API; MCP server (~21★); vectorized search + changelog summarization (premium).
- **Methodology:** server-side GitHub fetch → flat tree+content dump; no AST/compression.
- **Token mechanism:** none (raw delivery). **Traction:** low GitHub surface; testimonials exist. **Openness:** freemium SaaS, OSS MCP. **Limit:** no compression/ranking/budget; opaque pricing.

### codefetch — regenrek/codefetch [open-source MIT]
- **One-liner:** Node/TS CLI converting a local codebase or website into Markdown with model-aware token counting.
- **Method tags:** repo-flatten, markdown-output, token-count, multi-model-tokenizer, SDK
- **Key features:** `codefetch-sdk`; local + URL scrape; multi-model token counts; gitignore-respect.
- **Methodology:** dir walk → Markdown code blocks; web fetch mode; no AST/compression.
- **Token mechanism:** none beyond filtering. **Traction:** ~440★ (quiet since late 2025). **Openness:** MIT. **Limit:** low momentum; no ranking/compression.

### 1filellm (onefilellm) — jimmc414/onefilellm [open-source MIT]
- **One-liner:** Multi-source aggregator (GitHub repo/PR, arXiv, YouTube transcripts, web docs) into one XML file on the clipboard.
- **Method tags:** repo-flatten, multi-source, web-scrape, PDF-ingest, XML-output, clipboard, stopword-removal
- **Key features:** many source fetchers; optional stopword/punctuation removal; XML-wrapped; Flask UI + CLI; token count.
- **Methodology:** source-type detection → fetcher; optional NLP preprocessing; XML per source.
- **Token mechanism:** stopword removal (lossy). **Traction:** ~1,977★. **Openness:** MIT. **Limit:** lossy for code; no query-aware selection.

### GPT-Repository-Loader — mpoon/gpt-repository-loader [open-source MIT]
- **One-liner:** The original (2023) repo-to-prompt script; `.gptignore`, flat text. Superseded.
- **Method tags:** repo-flatten, gitignore-respect, minimal, legacy
- **Methodology:** dir walk → concatenation with `---` separators; no token count/AST/MCP.
- **Traction:** ~2,976★ (archived, last push 2024). **Openness:** MIT. **Limit:** unmaintained, superseded.

---

## Prompt / context compression

### LLMLingua / LLMLingua-2 / LongLLMLingua — microsoft/LLMLingua [open-source MIT]
- **One-liner:** Microsoft Research's three-generation small-LM prompt compressors, up to 20× compression with minimal accuracy loss.
- **Method tags:** compression-LM, token-pruning, perplexity-scoring, RAG-aware, task-agnostic, KV-cache
- **Key features:** **LLMLingua** (EMNLP'23) coarse+fine compression via a small surrogate LM, 20× at ~1.5pt drop on GSM8K; **LLMLingua-2** (ACL'24) BERT-class token-classification (keep/drop), 3–6× faster, task-agnostic; **LongLLMLingua** question-conditioned for long-context/RAG (+21.4% retrieval at 4× reduction; mitigates "lost in the middle"); LlamaIndex/LangChain integration; KV-cache support.
- **Methodology:** surrogate LM scores token perplexity → prune low-perplexity (redundant) tokens; v2 = binary token classification; LongLLMLingua = question→doc relevance (coarse) + question-conditioned token pruning (fine).
- **Token mechanism:** up to 20×; cited production case $42K/mo→$2.1K/mo. **Traction:** ~6,256★, peer-reviewed. **Openness:** MIT. **Limit:** needs a running surrogate LM (latency); non-deterministic across runs.

### Selective Context — research [open-source]
- **One-liner:** Removes low-self-information sentences/tokens using a small LM's surprisal signal; LLMLingua predecessor.
- **Method tags:** compression-LM, self-information, token-pruning, research-prototype
- **Methodology:** small LM per-token log-prob → drop low-surprisal units; query-agnostic.
- **Token mechanism:** ~50–70% reduction, moderate accuracy impact. **Traction:** research code (verify). **Limit:** query-agnostic retains task-irrelevant noise; LLMLingua outperforms.

### NVIDIA KVpress — NVIDIA/kvpress [open-source Apache-2.0]
- **One-liner:** Inference-level KV-cache eviction library (SnapKV, PyramidKV, KVzip) for 2–4× memory/latency cuts without prompt rewriting.
- **Method tags:** KV-cache-compression, attention-scoring, inference-level, multi-algorithm
- **Key features:** HF Transformers plug-in; multiple algorithms; KVzip (NeurIPS'25 Oral) query-agnostic eviction via reconstruction scoring (3–4× KV, ~2× decode); FlashAttention integration.
- **Methodology:** attention/reconstruction scores rank KV pairs; evict low-importance after prefill.
- **Token mechanism:** 3–4× KV reduction → VRAM + decode-latency gains. **Traction:** ~1,102★ (NVIDIA-backed). **Openness:** Apache-2.0. **Limit:** inference-side only — no benefit to API-only consumers paying per input token.

### FastKV — dongwonjo/FastKV [open-source, ACL Findings 2026]
- **One-liner:** Decouples context reduction from KV quantization; Token-Selective Propagation skips full context through late layers.
- **Method tags:** KV-cache-compression, token-selective-propagation, quantization, inference-level
- **Methodology:** TSP mid-decoder layer propagates only critical tokens' hidden states; combine with KV quantization.
- **Traction:** ~218★ (research-stage). **Limit:** prototype, not yet drop-in.

---

## Methodology patterns in this category

1. **Verbatim flatten + filter** (Repomix basic, gitingest, files-to-prompt, yek, GPT-repo-loader) — walk, exclude via gitignore/patterns, concatenate with path headers. Fast, deterministic, lossless; no query intelligence.
2. **AST-based skeleton compression** (Repomix compress, RepoPrompt CodeMaps, code2prompt AST) — tree-sitter parses → strip bodies, keep signatures/types. ~30–70% savings; lossless for navigation, lossy for implementation.
3. **Relevance-ranked token budgeting** (yek git-history, RepoPrompt query-driven, LongLLMLingua coarse) — score by a proxy (git frequency, similarity, perplexity), greedily fill a cap.
4. **Surrogate-LM perplexity pruning** (LLMLingua family, Selective Context) — small LM scores redundancy; 4–20× compression with tunable loss; adds latency + a model dependency.
5. **Inference-side KV-cache eviction** (KVpress/KVzip, FastKV) — evict low-importance KV pairs post-prefill; transparent to the prompt author; requires self-hosted serving.

## Relevance to a local, token-cheap, deterministic code-intelligence tool with a compact tabular wire format + dual (agent/exec) audience

**Worth borrowing:**
- **yek's git-history priority signal** — pure `git log`, deterministic, no LLM; ideal for deciding which modules populate the "hot" rows of a wire format. (FACTS already has `churnScore`/`lastModifiedMs`.)
- **AST skeleton mode (Repomix/CodeMaps)** — a symbol-level row per declaration (not per line) is both human-scannable and token-efficient — exactly the FactsPack `declarations`/`symbols` direction.
- **LLMLingua-2 binary token-classification** — if a small model is acceptable at query time, best quality/speed for compressing free-text cells (commit messages, docstrings). But it breaks determinism — keep it opt-in, outside the deterministic core.
- **RepoPrompt line-slice** — for oversized files, emit only relevant line ranges; a byte-offset/line index per symbol enables this without re-parsing.

**Where these fall short for the FACTS use case:**
- None emit a **structured tabular/columnar wire format** — all produce flat text/XML for chat paste. The flat-dump → typed columns + metrics + relational keys step is unbuilt elsewhere.
- Query-agnostic flatteners can't serve the **exec dashboard** axis (hotspots, dependency graph) without a downstream LLM reading a wall of text.
- LLM-dependent compressors are **non-deterministic and latency-additive** — incompatible with a deterministic, diffable, CI-cached artifact.
- KV-cache approaches live inside the serving stack — invisible to a tool that controls what enters context in the first place.
