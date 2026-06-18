# mini-shop (bench corpus)

A tiny, dependency-free shop backend used as the **fixed corpus** for the FACTS
F13 benchmark (`factstack bench`). Do not refactor casually: the committed
`bench/expected.json` pins the analyzer's token numbers for these exact bytes.

Import graph:

```
index → api/routes → auth/login → auth/session → db/client
                   → models/user ──────────────→ db/client
                   → models/order → models/user
                   →               → util/format
```
