# FactsPack (.pack) — paste-ready prompt

> Copy everything below the next horizontal rule into any LLM chat (system
> prompt or first user message). It's self-contained — no references to
> external files. Once pasted, the model can both **decode** PACK responses
> from tools and **emit** PACK when asked.

---

You are working with **FactsPack** (`.pack`), a line-oriented text format for
streaming structured tabular data efficiently to and from LLMs. PACK is
designed for big homogeneous tables (symbol tables, import edges, findings,
references). For small varied records use JSON; for trees use indented
plaintext; for prose use Markdown.

## Grammar — 8 lines, learn once

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

That is the entire grammar. UTF-8 only. Field separator is the ASCII tab
(`\t`). Record separator is the newline (`\n`). Reserved first bytes:
`# @ & - + x`. Anything else on the first byte of a line is undefined.

## Worked example

A symbol table with 5 entries:

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

PACK ≈ 60 tokens; JSON ≈ 150. On a 5,000-row response that's 28k vs 150k
tokens.

## Decoding rules

1. Read the header (`#`) for producer/version, schema/version, snapshot id,
   row count. Reject if the schema version isn't one you understand.
2. Build a dict from every `@ K=V` line. Forward references are allowed —
   finalize after the whole pack is read in non-streaming mode.
3. The most recent `& Name col1 col2 …` line sets the active schema. A
   single pack MAY contain multiple `&` lines for multi-table responses.
4. Each `- v1 v2 …` is a row of the active schema, positional. Cells under
   uppercase columns are dictionary keys; expand them. Cells under lowercase
   columns are literal strings.
5. `+` rows are additions; apply on top of an existing snapshot.
6. `x rowId` deletes by primary key (column 1 by convention).
7. Empty cells are the empty string. A bare `-` cell means null/missing.
8. Reverse `\t \n \\` escapes inside cell values.

## Encoding rules

When asked to **emit** PACK:

1. Write the `#` header with producer/version, schema/version, an opaque
   snapshot id (commit SHA when available), and the row count.
2. Choose interned columns (uppercase names) for any column whose values
   repeat across many rows — file paths, package names, rule ids. Skip
   interning for unique-per-row columns; it just adds overhead.
3. Emit `@ K=V` entries before (or anywhere in) the file; preceding usage
   is preferred for streaming.
4. Emit `&` schema once per table, then `-` rows beneath it.
5. Tab-separate fields. Escape any tab/newline/backslash inside a cell.
6. Don't quote strings — PACK has no quoting layer. Escape the three
   reserved characters and you're done.
7. Don't put nested objects in cells. Promote them to their own table
   referenced by id.
8. Don't emit binary data. Base64-encode at the producer if absolutely
   necessary.

## Multi-table example

```
# facts/0.1 multi-v1 88e9a1b 5
@ F1=src/auth.ts
@ F2=src/users.ts
& symbols   id   k     n         F    l
- 1         fn   login     F1   42
- 2         fn   logout    F1   58
& imports   id   F     to
- 1         F1    react
- 2         F1    ./jwt
& findings  id   tool    rule  F    l    sev    msg
- 1         ruff  E501    F2   12   warn long line
```

One response, three tables. The active schema switches at each `&`.

## Incremental updates

`+` and `x` lines let a follow-up call ship only what changed:

```
# facts/0.1 symbols-v1 88e9a1b 0
@ F1=src/auth.ts
& symbols   id   k     n         F    l
+ 6         fn   reset     F1   70
x 3
```

`row count = 0` in the header signals "patch only." A consumer applies
these on top of an earlier snapshot.

## When to use PACK vs other formats

| Shape | Format | Why |
|---|---|---|
| Big homogeneous tables | **PACK** | repetition kills JSON |
| Small or varied records | **JSON** with 1-character keys | nesting handles cleanly |
| Trees / hierarchies | **indented plaintext** | scans visually |
| Prose | **Markdown** | rendered downstream |
| On-disk storage | **SQLite** | not a PACK use case |

## Anti-patterns

- Don't use PACK as a storage format — it's a wire format.
- Don't put nested objects, JSON, or binary in cells.
- Don't intern columns whose values don't repeat.
- Don't ship PACK to browsers. They want JSON.
- Don't omit the header.

## What is FACTs?

PACK was created for **FACTs (Fun AI Coding Tools)** — a static-analysis +
indexing system that lets a developer or an AI agent understand any
codebase. The `facts` CLI scans a repo, builds a SQLite index, and serves
that index to AI agents over MCP/HTTP using PACK as the wire format for
big-table verbs (`find_symbols`, `get_importers`, `findings`, etc.).

You don't need to know more about FACTs to use PACK. Treat any PACK payload
as a self-describing tabular response.

---

End of pasteable prompt.
