# FACTS architecture diagrams

Auto-generated Mermaid diagrams via `factstack export-diagram`. Refresh:

```bash
factstack export-diagram . --view package --out docs/architecture/package.md
factstack export-diagram . --view hub --out docs/architecture/hubs.md
factstack export-diagram . --view focal --focus packages/spec/src/index.ts --depth 2 --out docs/architecture/focal-spec.md
```

Three views, each answering a different question:

| File | View | Answers |
| --- | --- | --- |
| [`package.md`](package.md) | Package-level | "What's the architecture at the package level?" Inter-package imports aggregated with counts. |
| [`hubs.md`](hubs.md) | Top hubs | "Which files have the most leverage?" Top-3 most-imported files + their direct importers. |
| [`focal-spec.md`](focal-spec.md) | Focal | "What would break if I changed `@factstack/spec`?" Caller graph rooted on `packages/spec/src/index.ts`, depth 2. |

## Edge style vocabulary

| Arrow | Meaning |
| --- | --- |
| `-->` | Regular `import` |
| `-.->` | `import type` (dashed = lighter coupling) |
| `==>` | `import('...')` (dynamic) |

Counts on aggregated edges (e.g. `-->|3|`) appear in the package view when multiple file-level edges collapse to one package-level edge. The strongest-coupling edge style wins for the merged arrow.
