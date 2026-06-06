# Code-Intelligence Infrastructure / Static Analysis / Symbol-Index Plumbing — Market Dossier

> CIO market-landscape scan · captured 2026-06-06 · part of the FACTS competitive landscape (see [`./index.html`](./index.html) and [`../index.html`](../index.html)).
> The open building blocks that extract symbols, references, and dependency graphs from source — the layer a higher-level tool builds on.

---

### tree-sitter — tree-sitter/tree-sitter [open-source MIT]
- **One-liner:** Incremental, error-tolerant parser generator that builds and updates concrete syntax trees in milliseconds; the de-facto grammar substrate for modern tooling.
- **Method tags:** incremental-parse, grammar-DSL, CST, WASM
- **Produces:** per-file CSTs; named nodes queryable via S-expression patterns; **no cross-file resolution natively.**
- **Methodology:** grammars are JS/JSON DSLs compiled to C; GLR-family algorithm re-parses only changed bytes (sub-100ms on 10k-line files); `web-tree-sitter` compiles the core to **WASM** (since v0.26.1 auto-downloads wasi-sdk); `tree-sitter-language-pack` ships 305 pre-compiled grammars; ABI 15 (v0.26.9, May 2026) added supertype tables.
- **Multi-language:** 305+ grammars — adding a language = a grammar file, not a hand-written parser (community quality varies).
- **Adoptability:** best-in-class. `web-tree-sitter` runs identically in browser + Node; load per-language `.wasm` at runtime; query API handles symbol extraction.
- **Traction:** ~25.7k★; embedded in Neovim, Copilot, stack-graphs, Helix, Zed, Semgrep (partial), CodeQL frontends. **Openness:** MIT. **Limit:** CSTs only — no cross-file refs/types/call graphs without a layer on top.

### Universal Ctags — universal-ctags/ctags [open-source GPL v2]
- **One-liner:** Community fork of Exuberant Ctags generating flat tag indexes (symbol→file:line) for 100+ languages via regex/lightweight parsing.
- **Method tags:** regex-parse, tags-file
- **Produces:** tags mapping symbol names to locations; optional JSON/xref; **no reference tracking, no types.**
- **Methodology:** per-language parser plugins (C/regex) emit tag records; best-effort scope/signature fields; JSON/xref for machine consumption.
- **Multi-language:** 100+; adding one = a C parser plugin. **Adoptability:** good for go-to-definition; insufficient for call/dep graphs. **Traction:** ~7.2k★. **Openness:** GPL v2. **Limit:** no reference index; regex false positives.

### LSIF — Microsoft / LSP ecosystem [open standard]
- **One-liner:** JSON graph-dump format (v0.6.0) letting a language server serialize its whole-workspace knowledge (defs, refs, hover, diagnostics) to a static file.
- **Method tags:** LSP-index, graph-dump
- **Produces:** typed vertex/edge graph encoding LSP responses for a snapshot; queryable offline without a running server.
- **Methodology:** per-language indexers (lsif-node, lsif-java, lsif-go…) invoke the compiler/type-checker and serialize line-by-line JSON; Sourcegraph found gzipped LSIF ~4× larger than equivalent SCIP.
- **Multi-language:** indexers for Go/TS/Java/C++/Rust/Python/C#; each a separate project. **Adoptability:** lsif-node well-maintained; other languages = run each indexer out-of-process. **Traction:** adopted by VS Code/GitHub/Sourcegraph; largely **superseded by SCIP.** **Openness:** open standard (MIT spec). **Limit:** verbose; each indexer its own project; no active extension.

### SCIP — sourcegraph/scip [open standard, Apache-2.0]
- **One-liner:** SCIP Code Intelligence Protocol — a **protobuf-encoded, compact** LSIF successor defining a universal schema for symbols/defs/refs/docs across any language.
- **Method tags:** LSP-index, protobuf-index
- **Produces:** an `index.scip` protobuf — per-document occurrence tables (symbol + role bitmask), a global symbol table with docstrings/relationships, external refs.
- **Methodology:** `scip.proto` defines `Index/Document/Occurrence/SymbolInformation`; indexers (scip-typescript, -java, -python, -go, -rust, -dotnet; rust-analyzer + Meta Glean emit natively) run against source trees; `scip` CLI converts to/from LSIF, snapshots, diffs, prunes (v0.8.1, June 2026). Consumed by Sourcegraph, Mozilla Searchfox, Meta Glean.
- **Multi-language:** ~10 first-class indexers; any compiler/LSP language can emit it; format is language-agnostic. **Adoptability:** `scip-typescript` is production-grade — ingesting its index gives full cross-file go-to-def/find-refs without a live language server. **Traction:** ~646★ (spec repo); broad adoption. **Openness:** Apache-2.0, vendor-neutral. **Limit:** requires a per-language indexer binary (usually the full build toolchain); not for on-the-fly/in-browser parsing.

### GitHub Stack Graphs — github/stack-graphs [open-source Apache-2.0]
- **One-liner:** Graph-theoretic name-binding framework (arXiv 2211.01224) computing precise go-to-def/find-refs across repos with zero build configuration.
- **Method tags:** scope-graph, incremental-name-resolution, tree-sitter-based
- **Produces:** per-file scope graph (scopes/defs/refs nodes; scope-link edges), merged repo-wide; resolves references precisely without type inference.
- **Methodology:** each language ships a **TSG** (tree-sitter graph DSL) annotating CST nodes with stack-graph semantics; graphs are file-local + composable (partial indexing valid); name resolution = pushdown-automaton reachability (handles shadowing/imports/re-exports). Powers GitHub Precise Code Navigation (TS all repos, Python GA, JS, Java).
- **Multi-language:** per-language `.tsg` (~100–200 lines on an existing grammar). **Adoptability:** high conceptually; **Rust-only runtime today, no WASM** — browser use needs porting (algorithm is small). **Traction:** ~877★ (lib crate), GitHub-scale production. **Openness:** Apache-2.0. **Limit:** name binding only — no types/dataflow/call graph.

### Google Kythe — kythe/kythe [open-source Apache-2.0]
- **One-liner:** Cross-language, schema-driven code-indexing framework (from Google's monorepo) producing a universal fact graph via a serving layer.
- **Method tags:** build-integrated-index, fact-graph, cross-language-schema
- **Methodology:** extractors intercept compiler invocations (Bazel/CMake); per-language indexers walk compiler IR → typed triples (defs/refs/types/calls/docs); serving layer answers xref/decor/doc.
- **Multi-language:** C++/Go/Java/TS/Rust/Python (partial); each needs a compiler-coupled extractor. **Adoptability:** **poor** — build-system coupling, no WASM, Bazel-centric; maintenance mode (core team laid off Apr 2024). **Traction:** ~3.6k★, foundational but stagnant. **Openness:** Apache-2.0. **Limit:** build-coupled; thin community.

### Meta Glean — facebookincubator/Glean [open-source BSD-style]
- **One-liner:** Schema-driven, **Datalog-queryable** fact database for code intelligence, used at Meta to power navigation, search, and LLM context at monorepo scale.
- **Method tags:** datalog-query, fact-db, schema-typed
- **Methodology:** language indexers write typed facts per schema (C++/Hack/Python/Haskell/Flow); LSIF/SCIP ingestion bridges Go/Java/Rust/TS; **Angle** (Datalog-like) queries traverse call chains/transitive deps/type hierarchies; incremental indexing; open-sourced Dec 2024.
- **Multi-language:** ~5 native + ~10 via SCIP/LSIF bridge. **Adoptability:** medium — ingest scip-typescript into Glean for Angle-queryable facts; **Haskell server, no browser path.** **Traction:** ~1.35k★, production at Meta. **Openness:** BSD-style. **Limit:** operationally complex; server-side, not ephemeral/browser.

### Semgrep — semgrep/semgrep [LGPL v2.1 CE; proprietary platform]
- **One-liner:** Pattern-match static analysis over ASTs ("grep for code structure") for 30+ languages, with taint/dataflow in Pro.
- **Method tags:** pattern-match, AST-query, taint-dataflow, SAST
- **Methodology:** YAML AST-template patterns with metavariables; CE per-file; Pro interfile engine builds a lightweight call graph for taint (redesigned 2026, ~30% faster); mixed parser stack (tree-sitter, pfff). v1.165.0 (June 2026).
- **Multi-language:** 30+. **Adoptability:** good as a SAST/lint layer atop a graph; not a primary symbol index. **Traction:** ~15.4k★, venture-backed. **Openness:** CE LGPL; platform proprietary. **Limit:** matcher, not a symbol DB — no "all callers of X" without Pro.

### ast-grep — ast-grep/ast-grep [open-source MIT]
- **One-liner:** Rust CLI/library for structural AST search, lint, and rewrite using tree-sitter grammars; 26+ built-in languages.
- **Method tags:** AST-query, pattern-match, rewrite, tree-sitter-based
- **Methodology:** wraps tree-sitter; `$VAR` metavariable patterns; NAPI bindings (`ast-grep-js`/`-py`); WASM grammar companion; YAML rules with fix/message/severity. v0.43.0 (June 2026).
- **Multi-language:** 26 built-in + any tree-sitter grammar. **Adoptability:** excellent for pattern-based extraction/codemods without a full indexer; usable in Node. **Traction:** ~14.3k★. **Openness:** MIT. **Limit:** no cross-file resolution; stateless per run.

### CodeQL — github/codeql [queries MIT; engine proprietary]
- **One-liner:** GitHub's semantic engine — compiles source to a relational DB, then answers Datalog-style QL queries for vulns and structural facts.
- **Method tags:** datalog-query, semantic-db, SAST, call-graph, data-flow
- **Methodology:** per-language extractor invokes the compiler to capture compiler-grade IR (types, CFG, call graph, dataflow); QL (OO Datalog) traverses; v2.25.4 (2026), 491 security queries / 166 CWEs; 12 languages.
- **Adoptability:** best-in-class call graph/dataflow for JS/TS, but **build-coupled extraction, closed engine, no browser path.** **Traction:** ~9.7k★ (queries), industry-standard SAST. **Openness:** queries MIT, CLI free, GHAS for private CI. **Limit:** heavy; closed engine.

### Madge — pahen/madge [open-source MIT]
- **One-liner:** JS/TS-only module-dependency graph generator (circular-dep reports, DOT/image).
- **Method tags:** import-graph, dep-graph
- **Methodology:** `@babel/parser`/`precinct` extract import strings; Node resolver; **import paths only, no symbol resolution.**
- **Traction:** ~10.1k★ (maintenance-mode). **Openness:** MIT. **Limit:** JS-only; no symbols.

### dependency-cruiser — sverweij/dependency-cruiser [open-source MIT]
- **One-liner:** Configurable JS/TS/CoffeeScript dependency validator + visualizer with architectural rule enforcement.
- **Method tags:** import-graph, dep-graph, rule-engine
- **Methodology:** acorn/Babel/TS-API import parsing (webpack aliases, tsconfig paths); `allow`/`deny` rule DSL for CI; cyclic detection. v17.4.3 (2026).
- **Traction:** ~6.7k★, used in enterprise JS monorepos. **Openness:** MIT. **Limit:** JS ecosystem only; no symbol-level intelligence.

### jscpd — kucherenko/jscpd [open-source MIT]
- **One-liner:** Token-based copy/paste detector for 225+ formats; v5 ships a Rust engine (`cpd`) + MCP server.
- **Method tags:** token-hash, duplicate-detection
- **Methodology:** tokenize → hash sliding windows → match across files; JSON/HTML/MCP output.
- **Traction:** ~4.6k★. **Openness:** MIT. **Limit:** token-level only; false positives on boilerplate.

### SciTools Understand — SciTools [proprietary]
- **One-liner:** Commercial polyglot static-analysis workbench (C/C++/Java/Python/C#/Ada/Fortran…) with call graphs, dependency matrices, metrics, scriptable API.
- **Method tags:** semantic-index, call-graph, dep-matrix, metrics, API
- **Methodology:** proprietary per-language parsers; Python/Perl API for custom queries; MISRA compliance; embedded/automotive/aerospace.
- **Traction:** 30+ year legacy, dominant in defense/automotive. **Openness:** proprietary (~$1,200–1,400/seat/yr). **Limit:** closed, no embedding API, no WASM, expensive.

---

## Methodology patterns

- **Parser-based (tree-sitter, ast-grep, ctags):** per-file CST/tags; scale to many languages by adding grammars; fast, incremental, browser-capable (WASM); no cross-file semantics.
- **Index-format standards (LSIF, SCIP):** serialize language-server/compiler output to a neutral file; consumers ingest offline; coverage grows by adding per-language indexers; needs build toolchains.
- **Query-engine / fact-DB (CodeQL, Glean, Kythe, SciTools):** compiler-grade extraction into a queryable DB (QL/Angle); richest semantics; heaviest infra; not browser/on-demand.
- **Scope/binding graph (stack-graphs):** tree-sitter CST + scope-graph DSL; composable per-file precise name resolution without a type-checker; middle ground.
- **Import-graph / token tools (Madge, dependency-cruiser, jscpd):** JS-only or token-level; lowest cost, lowest semantics.

## Relevance to a local, isomorphic (browser+Node), deterministic code-graph tool that today parses JS/TS with Babel and wants compiler-grade multi-language symbols

- **Immediate: adopt `web-tree-sitter` for JS/TS and beyond.** MIT, WASM, ESM — runs identically in browser + Node; per-language `.wasm` grammars load on demand; query API handles symbol extraction with no hand-written parsers. This is the cleanest path off the Babel-only constraint while preserving the isomorphic invariant.
- **Cross-file resolution: re-implement the stack-graphs scope-graph idea in TS** over tree-sitter query output (the pushdown-automaton reachability algorithm is small; the Rust crate has no WASM build yet).
- **For CI-built precision: ingest SCIP.** `scip-typescript` (and friends) emit a compact protobuf index encoding every def/ref — ingest at index time, query the graph at runtime; compiler-grade symbols without re-implementing a type-checker.
- **Avoid as dependencies:** CodeQL (closed engine), Kythe (build-coupled, maintenance-mode), SciTools (proprietary, no embedding API), Glean (Haskell server, not browser-embeddable). Semgrep/ast-grep are a useful lint/search layer, not a symbol index.
- **Recommended stack:** `web-tree-sitter` (parse) + a custom scope-graph layer (name binding) + optional SCIP ingest (CI-built compiler-grade indexes) + dependency-cruiser-style rules (JS/TS architecture enforcement).
