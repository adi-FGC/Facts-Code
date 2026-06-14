# FACTS benchmark (F13)

`factstack bench` reproducibly compares **tokens-to-context** for a fixed task
set over the committed corpus in [`corpus/`](corpus/README.md):

- **FACTS side** — one `get_context` call (F4): a ranked, budgeted context
  block. Tokens = the block's total; turns = 1.
- **Naive side** — what an agent without FACTS does: grep the task's content
  words (the *same* tokenizer F4 seeds with — one tokenizer, fair comparison)
  against file paths and read every hit in full. Tokens = sum of the matched
  files; turns = one read per file.

Both sides are judged for **recall** against the same per-task ground truth
(`expectedAnchors` in [tasks.json](tasks.json) = the files you must open to
make the change).

`bench/expected.json` is the committed report: same corpus bytes + same tasks
⇒ byte-identical output (`.gitattributes` pins LF so Windows checkouts match).
CI runs `factstack bench --check`; after an intentional corpus/task change run
`factstack bench --update` (the two flags are mutually exclusive by design).

## Reading the numbers honestly

Per-task budgets are **corpus-proportional** (~17% of total tokens, mirroring
an 8K budget on a 500K-token repo), **not** scaled to each task's answer —
scaling them to the expected anchors would leak ground truth into the measured
strategy. Consequence: on a corpus this small, a task whose only needed file
is tiny shows **negative savings by construction** (FACTS returns a
budget-sized context block; a lucky one-word grep reads one small file). Those
rows are reported, not hidden. The headline statistics are the **aggregate
savings** and the **recall comparison**: graph-blind grep both over-reads
noise (the corpus's test/legacy/docs files exist because real repos make
naive greps over-read) and, on real repos, misses graph-only dependencies.

> Editing anything under `corpus/` — including its README — changes the
> measured bytes and therefore the committed numbers. That's why this file
> lives outside `corpus/`.
