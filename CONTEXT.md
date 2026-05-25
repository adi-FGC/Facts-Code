# CONTEXT — FACTS domain & architecture glossary

Source-of-truth for the project's vocabulary. Maintained alongside the
code: when a new concept earns a name during architecture review or
feature design, it lands here.

The contract: nothing in this file is documentation about how to use
FACTS as a tool. That's `README.md` and `app_spec.md`. This file is
the **mental model** the code maintains internally — terms a
maintainer (or AI explorer) needs to know to reason about the
codebase without re-deriving them from scratch.

---

## Tier model (existing)

Per `app_spec.md` constraint C1, the analyzer is split into tiers
ordered by which Node features they're allowed to use:

1. **`spec`** — Zod schemas + abstract interfaces (`FactsFS`,
   `FileWriter`). No I/O of its own. Anything below depends on it;
   nothing else lives at this tier.
2. **`fs-*` adapters** — `fs-node`, `fs-memory`, `fs-browser`. Each
   implements `FactsFS`. Isomorphic constraint: none can import
   `node:*` except `fs-node`.
3. **`walker`, `parsers`, `extractors`, `graph`, `scanners`,
   `intent`, `core`** — the isomorphic analyzer tier. Pure
   (input → output). No I/O, no `node:*`.
4. **`emit/pure`** — isomorphic serialization (`encodeAgentPack`,
   `humanToViz`, the upcoming `writeArtifactsTo` orchestrator).
5. **`emit`** (Node-side I/O), **`emit-browser`** (FSA-side I/O) —
   adapters that wrap the orchestrator and provide platform-specific
   wiring (gitignore for Node, FSA permission upgrade for browser).
6. **`apps/*`** — CLI, MCP server, UI. Compose the analyzer with
   their respective adapters.

---

## Read tier — established vocabulary

### `FactsFS`
Pure interface for "where files are read from." Defined in
`packages/spec/src/fs.ts`. Methods: `readFile`, `readText`, `readDir`,
`stat`, `readlink`, `normalize`, `join`. Implemented by `NodeFS`,
`MemoryFS`, `FsaBrowserFS`. The walker takes a `FactsFS` and produces
walked files; downstream extractors never know which adapter they're
running on.

---

## Write tier — vocabulary introduced 2026-05-25

> **Why this section exists**: the write tier was forked into two
> top-level functions (`writeArtifacts` in `emit/`, `writeBrowserArtifacts`
> in `emit-browser/`) that duplicated ~200 LOC of orchestration. This
> deepening introduces a shared orchestrator + adapter interface,
> mirroring the read-tier `FactsFS` pattern.

### `FileWriter`
Pure interface for "where artifacts land." Lives in
`packages/spec/src/file-writer.ts` (alongside `FactsFS`). Minimum
viable methods:

- `writeText(path, body)` — write a string file, returns byte count
- `listKeys(dir)` — list immediate-child names (used for snapshot
  retention)
- `removeEntry(dir, name)` — delete a single file (used for snapshot
  retention pruning)

The orchestrator consumes only this interface; adapters supply the
I/O. Symmetric with `FactsFS` at the read tier.

### `writeArtifactsTo(writer, agent, human, options?)`
The orchestrator. Lives in `packages/emit/pure/`. Pure — no I/O of
its own, delegates everything to the `FileWriter` it's given.
Responsibilities:
- Validate `agent` + `human` against their Zod schemas
- Compute the file plan (which sidecar files to emit per options)
- Write each file via the `FileWriter`
- Run snapshot retention (list snapshots, sort, prune oldest)

The `To` suffix signals "the next argument is the destination" —
same idiom as `Array.from`, `Buffer.from`, `pipeTo`.

### `NodeFileWriter`
`FileWriter` implementation backed by `node:fs/promises`. Lives in
`packages/emit/src/node-writer.ts`. Used by the Node shim
`writeArtifacts(opts)` which also performs Node-specific extras
(gitignore append) around the orchestrator call.

### `FsaFileWriter`
`FileWriter` implementation backed by the File System Access API
(`FileSystemDirectoryHandle` + `FileSystemWritableFileStream`). Lives
in `packages/emit-browser/src/fsa-writer.ts`. Used by the browser
shim `writeBrowserArtifacts(opts)`.

### `writeArtifacts` (Node shim)
Thin top-level export from `packages/emit/`. Constructs a
`NodeFileWriter`, calls `writeArtifactsTo`, runs
`ensureGitignoreEntry('.facts/')`. ~20 LOC. Backward-compatible
surface for existing CLI callers.

### `writeBrowserArtifacts` (browser shim)
Thin top-level export from `packages/emit-browser/`. Constructs an
`FsaFileWriter` (after upgrading the directory handle to readwrite
permission), calls `writeArtifactsTo`. Backward-compatible surface
for the in-browser scan flow.

---

## Architectural principles (not for re-litigation)

- **The interface is the test surface.** When `writeArtifactsTo` is
  pure, testing snapshot retention doesn't require a temp directory —
  the test passes a `MemoryFileWriter`, asserts on what got written.
- **One adapter ⇒ hypothetical seam. Two adapters ⇒ real seam.** Two
  `FactsFS` adapters (Node + memory) justify the read-tier seam. Two
  `FileWriter` adapters (Node + FSA) justify the write-tier seam.
  Adding a third (`S3FileWriter`, `MemoryFileWriter`) costs ~50 LOC
  each — no change to the orchestrator.
- **Adapter-specific extras stay on the adapter side.** Gitignore is
  Node-only; it lives in the Node shim, not in the orchestrator.
  Permission upgrade is FSA-only; it lives in the browser shim.
