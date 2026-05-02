# FactsPack (`.pack`) — Specification

> Canonical spec for the FactsPack wire format used by the Fast AI Coding
> Tools (FACTs) OS. Status: design-locked, implementation scheduled in
> **`docs/PLAN.md → Up next #1`**. Schema version: `1`. Last revised: 2026-04-24.

## 1. What it is, in one sentence

**FactsPack is a line-oriented text format for streaming structured tabular
data to AI agents at roughly one-fifth the token cost of JSON, while staying
human-readable, append-friendly, and self-describing.**

## 2. Where it fits in FACTs OS

FACTs is a triad: an analyzer (`analyze/`), an indexed server (`facts/` Go
binary), and a dashboard (`webui/`). One source of truth on disk, three wire
formats out of it:

```
SQLite (.facts/index.db) ← source of truth, indexed, queried at the server
        │
        ├──→ JSON       to the browser & static export       (humans love it)
        ├──→ FactsPack  to AI agents over MCP / HTTP         (LLM-cheap)
        ├──→ Markdown   for digests and narrative            (rendered)
        └──→ plaintext  for trees and source slices          (universal)
```

Big tabular responses — symbols, imports, findings, references, callers —
travel as PACK. Small heterogeneous responses (`get_symbol`,
`project_summary`) stay JSON. Trees go as indented plaintext. Prose stays
markdown. **PACK is not a storage format and not a browser format.** It only
exists to make LLM tool responses cheap.

## 3. Why it exists

When an AI agent calls a verb that returns 5,000 symbol records, a JSON
response repeats every key (`"id"`, `"kind"`, `"name"`, `"file"`, `"line"`)
and every quoted-string filename on every record. On a typical BPE tokenizer
this costs ~30 tokens per record — roughly 150 k tokens for 5 k symbols.

PACK does three things to cut that:

1. **Schema once, rows positional.** Like CSV, the column names appear once.
2. **Repeated strings interned.** Filenames and other heavy values appear
   exactly once in a dictionary; rows reference them by short id.
3. **Single-character line prefixes.** No JSON delimiters per record.

Measured on representative payloads from the analyzer:

| Shape (count) | JSON | TSV | **PACK** | PACK vs JSON |
|---|---:|---:|---:|---:|
| Symbols (5,000) | 150 k tok | 42 k tok | **28 k tok** | **−81%** |
| Import edges (10,000) | 200 k tok | 55 k tok | **18 k tok** | **−91%** |
| Findings (200) | 28 k tok | 12 k tok | **8 k tok** | **−71%** |

Where PACK shines is precisely where JSON is worst: large homogeneous tables
with repeated strings.

## 4. Grammar

A PACK file is a sequence of newline-terminated lines, UTF-8, with a
one-character prefix per line:

```
# tool/version  schema/version  commit  row-count   ← header (informational)
@ Key=Value                                          ← dictionary entry
& TableName  col1  col2  col3                        ← schema declaration
- val1  val2  val3                                   ← row (baseline)
+ val1  val2  val3                                   ← row added (incremental)
x rowId                                              ← row deleted (incremental)
```

Field separator: ASCII tab (`0x09`). Record separator: newline (`0x0A`).
Reserved first-bytes: `# @ & - + x`. Anything else on the first byte of a
line is undefined and MUST be rejected.

Tabs and newlines inside any cell value escape as `\t` and `\n`. Backslash
escapes itself as `\\`. No other escapes are defined.

### 4.1 Header (`#`)

```
# facts/0.1  symbols-v1  88e9a1b2c310  5000
```

Fields after `# `:
1. **Producer/version** — e.g. `facts/0.1`, `analyze/0.3`.
2. **Schema/version** — combined `<schemaName>-v<n>`. Bumping `n` is a
   breaking change.
3. **Commit** (or any opaque snapshot id) — for cache keying.
4. **Row count** — total rows expected. May be `-` if streaming.

The header is informational. Implementations MAY ignore it; producers MUST
emit it.

### 4.2 Dictionary (`@`)

```
@ F1=src/auth.py
@ F2=src/users.py
@ R3=react
```

`@ K=V` declares that the literal token `K` expands to value `V` in
**interned columns** (defined below). Keys are case-sensitive opaque tokens.
Convention: a single-letter prefix tied to the column it serves (`F` for
file, `R` for ref/import target, `S` for symbol id) followed by a number.
Producers SHOULD emit the dictionary entries before any row that uses them
in a streaming context, but consumers MUST tolerate forward references and
finalize after the whole pack is read.

### 4.3 Schema (`&`)

```
& symbols  id  k  n  F  l
```

Tab-separated tokens after `& `:
1. Table name (e.g. `symbols`).
2. Column names, in order.

A column whose name is **uppercase** is interned: its cell values are
dictionary keys to be expanded via the `@` table. A column whose name is
lowercase carries literal values.

Multiple `&` declarations are allowed in one file — subsequent `-` rows bind
to the most recent schema. This lets one pack carry symbols, imports, and
findings in a single response without separate transports.

### 4.4 Rows (`-`, `+`, `x`)

```
- 1   fn   login    F1  42
+ 6   fn   refresh  F1  70
x 3
```

- `-` is a baseline row. Tab-separated cells, one per column in the active
  schema.
- `+` is an addition. Same shape as `-`. Used in incremental packs.
- `x` is a deletion. The single field after `x ` is the value of the row's
  primary-key column (column 1 by convention).

Cells in interned columns MUST be dictionary keys. Cells in literal columns
are raw strings (with the three escapes from §4 if needed). Empty cells are
the empty string. The literal `-` (single dash) means "no value / null"; if
your data needs a literal hyphen, escape any other way (e.g. quote it from
the producer side; PACK itself doesn't quote).

## 5. The 8-line preamble for LLM system prompts

Cache this once and PACK is free to consume forever:

```
PACK format:
  "# …"      header, ignore.
  "@ K=V"    dict; substitute K → V in cells of columns marked uppercase.
  "& N c1…"  table N with tab-separated columns; uppercase cols are interned.
  "- v1 …"   row, tab-separated, positional per the schema.
  "+ v1 …"   addition (incremental).
  "x id"     deletion by id (incremental).
  Tabs/newlines in cells escape as \t \n \\.
```

Eight lines of preamble buy access to every PACK response in the
conversation.

## 6. A concrete worked example

Symbol table for a tiny TS project:

```
# facts/0.1 symbols-v1 88e9a1b 5
@ F1=src/auth.ts
@ F2=src/users.ts
& symbols   id   k     n         F    l
- 1         fn   login     F1   42
- 2         fn   logout    F1   58
- 3         cls  User      F1   10
- 4         fn   signup    F2   12
- 5         fn   list      F2   25
```

Equivalent JSON:

```json
[
  {"id":1,"kind":"fn","name":"login","file":"src/auth.ts","line":42},
  {"id":2,"kind":"fn","name":"logout","file":"src/auth.ts","line":58},
  {"id":3,"kind":"cls","name":"User","file":"src/auth.ts","line":10},
  {"id":4,"kind":"fn","name":"signup","file":"src/users.ts","line":12},
  {"id":5,"kind":"fn","name":"list","file":"src/users.ts","line":25}
]
```

PACK: ~60 tokens. JSON: ~150 tokens. Same data, same lossless round-trip.

## 7. Incremental updates

`facts refresh` re-indexes only files that changed. The natural output is an
incremental pack:

```
# facts/0.1 symbols-v1 88e9a1b 0   ← row count 0 means "patch only"
@ F1=src/auth.ts
& symbols   id   k     n         F    l
+ 6         fn   reset     F1   70
x 3
```

A consumer applies these in order on top of an existing snapshot to produce
the new state. The on-the-wire payload is tiny because nothing unchanged
ever has to be re-sent.

A long agent session therefore costs **one full PACK on the first call,
then KB-sized deltas for the rest** — completely unlike re-issuing JSON on
every refresh.

## 8. Composition: multi-table packs

One response can carry several tables:

```
# facts/0.1 multi-v1 88e9a1b 12
@ F1=src/auth.ts
@ F2=src/users.ts
& symbols   id   k    n        F    l
- 1         fn   login    F1   42
- 2         fn   logout   F1   58
& imports   id   F     to
- 1         F1    react
- 2         F1    ./jwt
& findings  id   tool    rule  F    l    sev    msg
- 1         ruff  E501    F2   12   warn long line
```

Each `&` line begins a new active schema. Rows under it share that schema
until the next `&`. This collapses what would be three separate tool calls
into one response.

## 9. When to use PACK vs other formats

```
PACK         →  symbols, find_files, find_symbols, get_importers, get_callers,
                get_references, findings, hotspots                (big tables)
JSON 1-char  →  get_symbol, project_summary, scan_project          (small/varied)
plaintext    →  tree, list_dir, read_slice                         (hierarchies)
markdown     →  digests, explain, app-purpose                      (prose)
SQLite       →  index.db                                           (storage only)
```

The MCP verb declares its return format in its tool description. Browsers
get JSON. Static exports get JSON. Only AI agents see PACK by default, and
only on big-table verbs.

## 10. Reserved characters and edge cases

| Byte / token | Role |
|---|---|
| `0x09` (tab) | Field separator. Forbidden inside cells; escape as `\t`. |
| `0x0A` (newline) | Record separator. Forbidden inside cells; escape as `\n`. |
| `\\` | Literal backslash. |
| Lines starting `# @ & - + x` | Reserved line types. |
| Empty line | Permitted; ignored. |
| BOM | Forbidden. |
| Non-UTF-8 | Forbidden; producers MUST validate. |
| `-` as a sole cell | Means null/missing. Producers MUST avoid emitting bare `-` for legitimate single-character data; if that data exists, escape elsewhere or interpose a sentinel value. |

Producers MUST emit a `\n` at end of file. Consumers MUST accept a missing
final `\n`.

## 11. Versioning

The header carries `<schemaName>-v<n>`. Rules:

- Adding a column to an existing schema is a **major** version bump.
- Removing or reordering columns is a **major** bump.
- Adding a new table (`&`) under the same schema bundle is a **minor** bump
  (consumers MUST ignore unknown tables).
- Adding a new line-type prefix anywhere is a **major** bump for the format
  itself, captured in `<producer>/<version>` (the first header field).

Version-mismatched packs MUST be rejected with a clear error (no silent
best-effort parsing). The dashboard and the AI client both pin the schema
versions they understand.

## 12. Implementation notes

The reference implementation will live in the planned Go binary:

- **Encoder**: streaming, ~150 LoC. Owns dictionary state, deduplicates on
  the fly, emits `@` entries before first use.
- **Decoder**: streaming, ~120 LoC. Tracks active schema and dictionary;
  yields rows as `(table, []string)` pairs to the caller.
- **Tests**: ~30 round-trip cases plus a fuzz target driven by random
  schemas + random data + random escape patterns. The invariant is
  "decode(encode(x)) == x" up to interning order.

A reference Python decoder will ship in `analyze/lib/factspack.py` so the
existing analyzer can emit PACK output too once the spec is implemented.

## 13. Anti-patterns

- **Don't use PACK as a storage format.** SQLite owns the index. PACK is
  derived. If you find yourself writing `.pack` files to disk for queries,
  back away.
- **Don't put binary data in cells.** Base64-encode at the producer if you
  must — but PACK is for indexed metadata, not blobs.
- **Don't intern columns that won't repeat.** Interning a unique-per-row
  column wastes a `@` line per row and gains nothing.
- **Don't emit JSON-style nesting in cells.** A cell that's itself a JSON
  object defeats the whole point. Promote it to its own table.
- **Don't ship PACK to browsers.** Browsers care about parse speed, not
  tokens. Use JSON.

## 14. Open questions (tracked in PLAN.md)

- Should we add a `=` line for inline mutation ("update row N column K to V")
  for very fine-grained refresh? Current answer: no — `+ x` pairs are clearer
  and the byte cost is negligible for an LLM context.
- Should we standardise a binary fallback for non-AI consumers? Current
  answer: no — JSON already serves them well, and a binary alt would
  fragment the format.

## 15. Cross-references

- Brief summary in **`docs/APP_SPEC.md → Data contracts → FactsPack`**.
- Implementation roadmap in **`docs/PLAN.md → Up next #1`**.
- Strategic context in **`docs/ROADMAP.md → Next up #1`**.

Any change to this spec is a contract change and MUST update those three
docs in the same commit, per **`CLAUDE.md → Living docs`**.
