# AI Coding Agents & Their Codebase-Context Engines — Market Dossier

> CIO market-landscape scan · captured 2026-06-06 · part of the FACTS competitive landscape (see [`./index.html`](./index.html) and [`../index.html`](../index.html)).
> Focus: HOW each agent gathers, indexes, ranks, and feeds codebase context, and its token strategy.

---

### Aider — Aider-AI/aider [open-source Apache-2.0]
- **One-liner:** CLI coding agent whose core innovation is a **repo-map**: a token-budget-aware, PageRank-ranked skeleton of the whole codebase injected each turn.
- **Context tags:** repo-map, tree-sitter-tags, graph-rank, token-budget-binary-search, git-diff-context
- **How it builds context:** tree-sitter extracts `name.definition.*` and `name.reference.*` tags per file (Pygments fallback). A directed weighted graph (nodes=files, edges=reference→definition, weight 1.0; isolated defs get 0.1 self-loops) is built. NetworkX **PageRank** runs with a personalization vector that boosts chat files + mentioned identifiers to `100/len(chat_fnames)` (50–100× baseline). Tags sorted by score; output built greedily (path + nested signatures) until the token budget; a binary-search loop trims/expands to fit exactly. Regenerated every message; git diff appended for edited files.
- **Token strategy:** default 1,024 map tokens; `map_mul_no_files` (default 8×, capped at window−4,096) when no files in chat; large-file line sampling; signature-only hierarchical format is the compression.
- **Key features:** any terminal; 60+ languages via tree-sitter; auto git commit per change; multiple edit formats; architect+editor dual-model mode.
- **Traction:** ~35k★ (2026), widely benchmarked; repo-map cloned by ≥4 projects. **Openness:** Apache-2.0, BYO keys. **Limit:** no persistent index (recompute per turn, O(n) on monorepos); no cross-repo; no IDE.

### Cursor — Anysphere [proprietary, VS Code fork]
- **One-liner:** AI IDE with an always-fresh, Merkle-tree-tracked vector index enabling semantic `@codebase` retrieval without re-embedding unchanged chunks.
- **Context tags:** embeddings-RAG, merkle-index, AST-chunking, vector-similarity, obfuscated-retrieval, team-shared-index
- **How it builds context:** Merkle tree of file-content hashes; on sync (~5 min / on save) only changed branches re-embed (content-addressed cache). Tree-sitter AST chunks embedded into Turbopuffer. On `@codebase`, query embedded → vector similarity returns obfuscated path+line refs → client dereferences locally (raw code not round-tripped unencrypted). A simhash layer enables shared team indexes (new teammates reuse cache).
- **Token strategy:** only top-k chunks injected; Composer adds open files/terminal/lint with configurable inclusion; no full-file dumps unless @-mentioned.
- **Traction:** leading commercial AI IDE; ~$100M ARR (verify); millions of users. **Openness:** freemium (~$20/mo Pro). **Limit:** cloud indexing; hashes leave machine; no native cross-repo graph; index lag on fast-changing monorepos.

### Continue.dev — continuedev/continue [open-source Apache-2.0]
- **One-liner:** Open VS Code/JetBrains extension with a pluggable, locally-computed index and hybrid (vector+FTS+AST) retrieval via `@Codebase`/`@Folder`.
- **Context tags:** embeddings-RAG, AST-chunking, FTS-SQLite, vector-LanceDB, incremental-hash-index
- **How it builds context:** tree-sitter extracts semantic blocks via `.scm` queries (line-chunk fallback); embeddings computed locally by default (`transformers.js`) into LanceDB (`~/.continue/index`); hashes/metadata in SQLite; incremental re-index. Four parallel backends: LanceDB (vector), SQLite FTS5 (keyword), code-snippets (AST symbol), chunking (raw); merged+ranked. Security filter strips `.env`/keys.
- **Token strategy:** top-k chunks truncated to model window; relies on chunk-size config + k (no explicit budget manager).
- **Traction:** ~25k★, largest OSS assistant community. **Openness:** OSS (+ paid Hub for config sync). **Limit:** no cross-repo; no built-in rerank; local embeddings lag cloud; slow cold-start on big repos.

### Cline — cline/cline [open-source Apache-2.0]
- **One-liner:** Agentic VS Code extension that deliberately **skips pre-built indexes**, navigating structurally — following imports and AST chains in real time.
- **Context tags:** agentic-file-read, AST-import-trace, filesystem-traversal, no-static-index
- **How it builds context:** no embeddings; agent loop issues `list_files`/`read_file`/`search_files`; model decides what to read. AST follows import/require chains; duplicate reads collapsed to a `[DUPLICATE FILE READ]` stub. Context tagged by source (`read_tool`/`user_edited`/`cline_edited`/`file_mentioned`) for recency pruning. `.clineignore` gates visibility.
- **Token strategy:** compress older tool-result turns; duplicate dedup; explicit truncation; ~1,000-file `@`-mention cap.
- **Traction:** ~70k+★ (most-starred agent repo). **Openness:** OSS, pay provider. **Limit:** scales poorly on huge monorepos (burns tokens navigating); no semantic "find all callers of X" without grep.

### Roo Code — RooCodeInc/Roo-Code [open-source Apache-2.0]
- **One-liner:** Cline fork adding an optional embedding-based semantic index (Qdrant) alongside agentic-read.
- **Context tags:** embeddings-RAG, AST-chunking, Qdrant-vector, agentic-file-read, hybrid
- **How it builds context:** experimental codebase indexing — AST-aware chunking (functions/classes; Markdown header blocks; line fallback) embedded into Qdrant; on `codebase_search` the `CodeIndexSearchService` vector-queries Qdrant. Retains full Cline agentic-read alongside.
- **Token strategy:** inherits Cline compression/dedup; semantic search cuts exploratory reads.
- **Traction:** ~30k+★, fastest-growing Cline derivative. **Openness:** OSS (self-host Qdrant). **Limit:** index experimental; Qdrant + embedding provider = operational overhead.

### Windsurf (Codeium) — Codeium [proprietary]
- **One-liner:** Agentic IDE with Cascade agent, proprietary **Riptide** indexing for monorepo scale, **M-Query** retrieval, and a layered context pipeline.
- **Context tags:** embeddings-RAG, proprietary-indexing, M-Query, SWE-grep, rules-and-memories, pipeline-assembly
- **How it builds context:** Riptide indexes millions of LoC (internals proprietary); 768-dim embeddings; M-Query claimed to beat naive cosine on precision; SWE-grep ~10× faster syntactic search. Each Cascade turn runs a fixed pipeline: global rules (`.windsurfrules`) → memories → open files → semantic retrieval → recent actions → prompt.
- **Token strategy:** plan-tier window sizing; compact rules+memories; ranked/trimmed snippets; summarized history (budget undocumented).
- **Traction:** 1M+ users; now owned by OpenAI (acquisition 2025, verify). **Openness:** freemium (~$20/mo). **Limit:** fully proprietary internals; cloud-dependent; M-Query/Riptide are marketing claims w/o published benchmarks.

### Augment Code — Augment [proprietary / open-core]
- **One-liner:** Enterprise-first agent whose **Context Engine** maintains a real-time, cross-repo semantic knowledge graph — the widest scope here.
- **Context tags:** embeddings-RAG, knowledge-graph, cross-repo, real-time-index, semantic-search, cloud-upload
- **How it builds context:** indexes 400k+ files across multiple repos ("full search engine for code" mapping relationships, not just text); real-time updates; on a request retrieves+compresses+ranks (documented: 4,456 sources → 682 relevant) respecting access permissions. Workspace uploaded to Augment cloud on first open.
- **Token strategy:** explicitly curates rather than dumps; "infinite context window" framing = index is the scope, not the window.
- **Traction:** best SWE-bench Pro (51.80%, Apr 2026). **Openness:** proprietary SaaS, free tier. **Limit:** code leaves the machine; no self-host disclosed; cross-repo scale claims unverified.

### Zed AI — Zed Industries [open-source GPL/AGPL]
- **One-liner:** High-performance Rust editor favoring **manual, explicit context injection** via slash commands over auto codebase indexing.
- **Context tags:** explicit-context-injection, LSP-intelligence, open-buffer-context, slash-commands, no-semantic-RAG
- **How it builds context:** no cross-file embedding index; context = current + open buffers; `/diagnostics`, `/file`, `/symbol`, `/selection` scope precisely; multi-CPU tree-sitter+LSP indexing powers IDE features (not AI context); parallel agent panes each with independent explicit context.
- **Token strategy:** minimal by design; user controls exactly what enters; 80ms median autocomplete.
- **Traction:** ~60k★, growing among performance users. **Openness:** editor OSS; AI needs account/own keys. **Limit:** no `@codebase` semantic retrieval; assembly is manual.

### GitHub Copilot — Microsoft/GitHub [proprietary]
- **One-liner:** Ubiquitous pair with a cloud-backed semantic workspace index (up to 1M-token scope via Azure Cognitive Search) + multi-strategy parallel retrieval for `@workspace`.
- **Context tags:** embeddings-RAG, Azure-vector-search, text-search, LSP-intelligence, parallel-retrieval, cloud-index
- **How it builds context:** GitHub-hosted repos indexed server-side (incremental); local repos build a local semantic index. `@workspace` races parallel strategies (semantic vector + text + file + language intelligence); fastest relevant wins; snippets inserted (≤1M-token scope). Graceful grep fallback while building.
- **Token strategy:** parallel multi-strategy selection of most-relevant snippets; no full-file dumps; mostly opaque.
- **Traction:** ~15M+ paid users (verify), largest install base. **Openness:** freemium ($10/$19/$39). **Limit:** index not inspectable; retrieval opaque; no default cross-repo.

### Amazon Q Developer — AWS [proprietary]
- **One-liner:** AWS-native agent with an opt-in local workspace index and deep AWS knowledge, but single-repo only.
- **Context tags:** local-index, workspace-context, @workspace, AWS-knowledge, keyword-chunk-retrieval
- **How it builds context:** local index built in-IDE (5–20 min initial; CPU-heavy); non-code + gitignored excluded; `@workspace` retrieves relevant chunks; incremental updates; pre-loaded AWS SDK/CloudFormation/IAM knowledge.
- **Token strategy:** chunk retrieval; only relevant segments injected.
- **Traction:** GA since 2023; large AWS base. **Openness:** free tier; Pro $19/user/mo. **Limit:** single-repo only; index not team-shareable; AWS-centric.

### Tabnine — Tabnine [open-core / proprietary]
- **One-liner:** Privacy-first assistant with local RAG + a new (Feb 2026) **Enterprise Context Engine** building an org-wide knowledge graph beyond simple RAG.
- **Context tags:** local-RAG-index, enterprise-knowledge-graph, entity-relationship-extraction, on-prem-VPC, air-gapped
- **How it builds context:** local RAG (chunk→embed→retrieve, supports local models, code can stay on machine); Enterprise Context Engine (GA Feb 2026) ingests code+docs+tickets to extract entities/relationships/dependencies into a knowledge graph agents reason over; per-turn scope controls.
- **Token strategy:** RAG top-k; graph queries return structured facts (more compact than raw code).
- **Traction:** ~1M+ devs; strong in regulated industries. **Openness:** free dev; Pro $12/mo; Enterprise VPC custom. **Limit:** Context Engine new (≈3 months as of June 2026), unvalidated externally; gen quality trails Cursor/Augment.

### JetBrains AI Assistant + Junie — JetBrains [proprietary]
- **One-liner:** IDE-native agent that uses JetBrains' own **PSI** static-analysis index (symbol search, call hierarchy, usage search) as the retrieval oracle instead of separate embeddings.
- **Context tags:** PSI-static-analysis, symbol-index, call-hierarchy, LSP-intelligence, semantic-search, no-separate-embedding
- **How it builds context:** Junie/AI Assistant query the deep PSI index directly ("symbol search, call hierarchy, usage search — rather than grepping raw text", May 2026); semantic search over PSI returns relevant snippets before prompting; multi-language via per-language PSI.
- **Token strategy:** PSI queries return structured minimal answers (a definition, a call-site list) — inherently compact; fewer tokens + round-trips.
- **Traction:** ~10M+ JetBrains users; May 2026 PSI-query update is a notable jump. **Openness:** included in All Products Pack (~$10/mo add-on). **Limit:** locked to JetBrains IDEs; PSI not exportable for other agents; no cross-repo.

---

## Methodology patterns in this category

- **Repo-map / graph-rank (Aider):** lightweight call-graph from tags + personalized PageRank → compact signature-only skeleton within a budget. Zero index storage, deterministic, O(n)/turn. Best for CLI/latency-sensitive, repos ≤~100k LoC. **(Closest existing analog to FACTS.)**
- **Embeddings-RAG (Cursor, Continue, Roo, Windsurf, Copilot, Q, Tabnine basic):** chunk→embed→vector store→similarity. Amortizes indexing, scales to millions of LoC; fuzzy (good for semantic, bad for precise "all callers"). Differentiators: re-embed trigger (Merkle = Cursor), index location (local vs cloud), retrieval precision (M-Query, Azure parallel).
- **Agentic-read / structural navigation (Cline, partly Zed):** no index; walk imports, read on demand. Most accurate for exact structure; highest exploration token cost; doesn't scale to "find all usages" without grep.
- **IDE static-analysis query (JetBrains PSI):** the IDE's own symbol graph as a retrieval oracle — precise + compact, but coupled to the IDE.
- **Emerging knowledge graphs (Tabnine Enterprise, Augment):** entity/relationship extraction beyond chunks → impact analysis + architectural reasoning. Early-stage.

## Relevance to a local, deterministic, token-cheap code-graph tool that could pre-assemble context for any agent

**Worth borrowing:**
- **Aider's personalized-PageRank loop** is the single most applicable primitive — build a weighted call-graph, bias toward touched files, emit signatures within a hard budget, no GPU/API. This is FACTS's "pre-injection" feature, validated.
- **Cursor's Merkle incremental invalidation** — content hashes per node; invalidate only reachable dependents on change → near-real-time freshness without full recompute (FACTS's incremental-refresh feature).
- **JetBrains' PSI-query model** — expose the graph as a queryable interface returning structured compact answers, rather than dumping chunks (FACTS's query/MCP surface).
- **Continue's hybrid (FTS5 + vector + AST symbol)** — a local tool can layer SQLite FTS5 over the graph for keyword fallback with zero external deps.
- **Tabnine/Augment knowledge-graph layer** — the right long-term abstraction for cross-file/cross-repo reasoning.

**Gaps none fill well (FACTS's opening):**
- No tool produces a **pre-assembled, agent-agnostic context payload** in a standardized compact wire format that *any* agent can consume — every engine is coupled to one agent's prompt format.
- No OSS tool does **incremental graph + PageRank refresh in <100ms** on change (Aider recomputes fully; others re-embed fully).
- **Cross-repo graph with local-only storage** — Augment needs cloud; nobody does it locally at scale.
