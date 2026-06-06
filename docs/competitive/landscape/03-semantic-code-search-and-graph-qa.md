# Semantic Code Search, Code-Graph & GraphRAG Q&A / Review — Market Dossier

> CIO market-landscape scan · captured 2026-06-06 · part of the FACTS competitive landscape (see [`./index.html`](./index.html) and [`../index.html`](../index.html)).
> Tools that index a codebase into a graph or semantic index so agents/humans can ask questions, navigate, or auto-review. (Sourcegraph covered separately in [`../sourcegraph.html`](../sourcegraph.html).)

---

### Greptile — Greptile Inc. [proprietary / SaaS]
- **One-liner:** Cloud PR-review agent that builds a full dependency graph and dispatches Claude-backed agents to review every PR with codebase-wide context.
- **Method tags:** AST-graph, embeddings, multi-hop agent traversal, MCP-compatible, cloud-only
- **Key features:** AST parse + recursive LLM-generated docstrings per node + embeddings (hybrid semantic/keyword/agentic search); multi-hop investigation tracing git history + dep chains for *why*; learns from team PR comments; v4 (early 2026) on Anthropic Claude Agent SDK; claims 82% bug-catch (vs 44% CodeRabbit, 54% Copilot); GitHub/GitLab/Bitbucket; custom rules.
- **Methodology:** on connect, AST → recursive docstrings → embeddings in managed store; relationship graph (calls/imports/deps); on PR, agentic fan-out follows references + blame; reviewer agent synthesizes inline comments.
- **Token/context angle:** graph traversal narrows the surface before the LLM; agents pull subgraphs, not whole files.
- **Traction:** YC-backed; enterprise teams. **Openness:** free tier (50 reviews/mo), then ~$1/review (switched from $30/user/mo Mar 2026); closed, cloud-only. **Limit:** no on-prem/air-gap; per-review cost unpredictable at scale; index freshness depends on webhooks.

### Bloop — BloopAI [open-source Apache-2.0; company discontinued]
- **One-liner:** Rust semantic code search ("ChatGPT for your code") — still self-hostable OSS, but the company pivoted to Vibe Kanban then shut down April 2026.
- **Method tags:** embeddings (Qdrant), regex, NL query, air-gapped capable
- **Key features:** NL + regex search over local/remote repos via Qdrant; BYOK or local model; air-gapped build; Tauri desktop app.
- **Methodology:** tree-sitter chunking → embeddings → Qdrant; no explicit relationship graph (embeddings + regex); LLM answers grounded on retrieved chunks.
- **Traction:** YC S21; company defunct Apr 2026; repo archived. **Openness:** Apache-2.0. **Limit:** dead as a product; no maintenance; no relationship graph; no MCP.

### Potpie — potpie-ai [open-source Apache-2.0 / open-core SaaS]
- **One-liner:** Converts a repo into a **Neo4j AST property graph**, then runs CrewAI specialist agents (debugger, tester, PR reviewer) over it for blast-radius-aware tasks.
- **Method tags:** AST-graph, Neo4j, CrewAI agents, embeddings (RAG layer), MCP-compatible
- **Key features:** full AST → Neo4j (nodes=files/functions/classes; edges=imports/calls/inheritance); pre-built agents (Debug, Test Gen, Code Changes/blast-radius, Feature Dev); custom agent builder; GitHub/VS Code/Slack; $2.2M pre-seed; ~$1.1M ARR mid-2025; Fortune 500 customers.
- **Methodology:** tree-sitter AST → Neo4j; Cypher + RAG resolve agent tool calls; Agent Router dispatches; incremental on file change.
- **Token/context angle:** Cypher subgraph queries return only relevant nodes.
- **Traction:** ~5.4k★ (active, pushed 2026-06-05). **Openness:** OSS core + cloud tier. **Limit:** Neo4j operational weight; cloud needed for full agents; RAG-over-graph approximate on deep chains.

### blarify — blarApp [open-source MIT]
- **One-liner:** Lightweight Python lib building a **Neo4j** code relationship graph via LSP, with **SCIP** fallback for up to 330× faster reference resolution.
- **Method tags:** LSP, SCIP, Neo4j, incremental
- **Key features:** LSP go-to-def/find-refs → edges; SCIP integration (330× faster than live LSP); incremental add/delete/modify; backs blar.io's commercial product.
- **Methodology:** walk repo → LSP requests per symbol (or SCIP index) → nodes+edges in Neo4j; no embeddings in core; consumers query with Cypher; blar.io adds AI on top.
- **Traction:** ~229★, MIT, active May 2026. **Openness:** MIT (+ blar.io SaaS). **Limit:** no semantic search; requires Neo4j; LSP slow without SCIP; thin community.

### Cosine / Genie — Cosine AI [proprietary / SaaS]
- **One-liner:** Fully agentic AI software engineer (Genie 2 proprietary model, 72% SWE-Lancer) combining semantic indexing with multi-agent async execution.
- **Method tags:** semantic indexing, static analysis, multi-agent, cloud SaaS
- **Key features:** file/function-level relationship index (semantic + static heuristics; no public graph DB); Genie 2 post-trained on commits/PRs/issues/static-analysis/self-play; niche language support (Fortran, Verilog, Matlab); multi-agent decomposition; GitHub/VS Code/Jira/Slack; AutoPM planning.
- **Methodology:** on connect builds semantic index; task → plan → specialist sub-agents → autonomous PRs; continuous background operation.
- **Token/context angle:** semantic index + multi-agent decomposition keep each agent's window focused.
- **Traction:** YC; Genie 2 live 2026; benchmark claims unreplicated. **Openness:** proprietary, sales-gated. **Limit:** black-box index+model; no on-prem; pricey at volume.

### Serena — oraios/serena [open-source MIT]
- **One-liner:** MCP toolkit that turns any agent into an IDE-grade developer by exposing **LSP-backed** symbol retrieval/navigation/editing as MCP tools — no vector DB, fully deterministic.
- **Method tags:** LSP, MCP, symbol-level, multi-language (40+), zero-vector
- **Key features:** 40+ languages via existing LSP servers; MCP tools (find-symbol, go-to-def, find-refs, rename, diagnostics, symbol-granular edit); works with Claude Code/Codex/Cursor/JetBrains; fully local; **~24.9k★** (top-5 MCP server), ~1,670 forks, pushed 2026-06-05.
- **Methodology:** spawn language server(s) on demand; agent calls MCP tool → Serena issues LSP request → structured symbol list; **no indexing step** (live authoritative answers); edits scoped to named symbols (refactor-resilient).
- **Token/context angle:** returns only the precise symbols/files requested; minimal overhead.
- **Traction:** fastest-growing code-focused MCP server. **Openness:** MIT, self-hosted. **Limit:** requires working LSP per language; cold-start LSP slow on big repos; no semantic/NL similarity (pure structural).

### mcp-language-server — isaacphi [open-source BSD-3-Clause]
- **One-liner:** Minimal Go MCP server wrapping a single LSP server to expose def/refs/rename/diagnostics as MCP tools.
- **Method tags:** LSP, MCP, Go, single-server bridge
- **Methodology:** stateless JSON-RPC proxy to one LSP; no cache/graph/embeddings.
- **Traction:** ~1.5k★ (stalling; superseded by Serena). **Openness:** BSD-3. **Limit:** single-language-per-process; no NL search.

### CodeGPT — CodeGPT Inc. [open-core / freemium]
- **One-liner:** VS Code/JetBrains extension with chat, autocomplete, and codebase-aware agents; BYOK; agent marketplace.
- **Method tags:** embeddings, RAG, BYOK, IDE-native
- **Methodology:** project indexed to embeddings on open; similarity retrieval; no AST graph (flat chunks); LLM grounded on top-k + IDE context.
- **Traction:** broad VS Code base; active 2026. **Openness:** free tier; Pro ~$9.99/mo (extension OSS, backend closed). **Limit:** embedding-only; weak multi-hop; no CLI.

### Pieces for Developers — Pieces App [proprietary / freemium]
- **One-liner:** Local-first developer **memory** platform capturing snippets + browser/IDE/terminal context into a timestamped semantic store, surfaced via MCP.
- **Method tags:** embeddings, local LTM, MCP, workflow-capture
- **Methodology:** PiecesOS daemon passively captures activity → local embedding index; MCP answers time-relative + semantic queries; **personal activity graph, not a structural code graph**.
- **Traction:** established; MCP integration early 2026. **Openness:** free personal; Teams ~$10/user/mo. **Limit:** personal memory, not repo intelligence; no AST/dependency graph; needs daemon.

### code-graph-rag — vitali87 / community [open-source MIT]
- **One-liner:** Research-grade GraphRAG for codebases: tree-sitter AST → **Memgraph** + UniXcoder embeddings, queried via NL→Cypher and an MCP server.
- **Method tags:** AST-graph, GraphRAG, tree-sitter, Memgraph, UniXcoder embeddings, MCP, NL-to-Cypher
- **Key features:** tree-sitter parses 12+ languages → functions/classes/modules + call/import edges in Memgraph; UniXcoder semantic embeddings; NL→Cypher via LLM; surgical AST-targeted edits with diff preview; MCP mode; Jan 2026 arXiv paper (AST-derived vs LLM-extracted graphs).
- **Methodology:** parse → AST extraction → Memgraph; embeddings in parallel; query: NL → LLM Cypher → Memgraph → embedding re-rank; edits via AST block replacement.
- **Token/context angle:** graph query returns only relevant nodes; embedding re-rank filters; compact Cypher result sets.
- **Traction:** community/research; academic interest. **Openness:** MIT. **Limit:** research maturity; Memgraph dependency; NL→Cypher variance; no incremental pipeline.

---

## Methodology patterns

- **AST-graph + embeddings (hybrid):** Greptile, Potpie, code-graph-rag. Strongest for multi-hop architectural reasoning + PR review. Cost: indexing latency, cloud dependency, or an operational graph DB (Neo4j/Memgraph) + vector store.
- **LSP-native / deterministic (no embeddings):** Serena, mcp-language-server, blarify (LSP/SCIP). Authoritative, zero-fabrication symbol resolution; no vector approximation. Trade-off: pure structural — NL similarity needs a separate layer.
- **Embeddings-only / flat RAG:** Bloop, CodeGPT, Pieces. Simplest to deploy; weakest multi-hop; best for snippet/personal retrieval.
- **Full agentic SWE:** Cosine. Index is a black box; differentiation is model + orchestration, not graph transparency.

## Relevance to a local, deterministic, token-cheap code-graph tool with a compact wire format + dual (agent/exec) audience

**Worth borrowing:**
- **Serena's zero-vector LSP pattern** proves deterministic structural answers are viable and wanted (~25k★) — adopt its MCP tool naming as de-facto convention.
- **blarify's SCIP-first fallback** (330× over live LSP) — make SCIP ingestion the fast path, LSP the fallback, for large/multi-language repos.
- **Potpie's incremental graph update** (add/delete/modify per file change) — the right primitive for a persistent graph (FACTS's incremental refresh).
- **code-graph-rag's compact Cypher→MCP result** maps directly onto a compact wire format: return graph subsets, not file dumps.
- **Greptile's per-node descriptor** — a lightweight per-symbol descriptor (deterministic, not LLM-generated) stored alongside edges serves the exec-audience.

**Market gap FACTS can exploit:** no tool is simultaneously **local-first, deterministic (no LLM in the index path), MCP-native, AND dual-audience** (structured JSON subgraphs for agents + compact human/exec output). Serena gets closest but has no persistent graph or NL search. A **SCIP + compact tabular wire format** for graph edges (vs heavy Neo4j or ephemeral live-LSP) is unexplored.
