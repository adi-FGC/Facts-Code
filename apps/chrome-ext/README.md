# @factstack/chrome-ext *(v0.4 stub)*

**Not built in v0.1.** Reserved for the Chrome extension surface — target audience: CXOs with no local toolchain who want to understand a GitHub repo without cloning.

## Design

- Manifest V3 extension.
- Injects FACTS UI into `github.com/*` repo pages (side panel + content overlay).
- Uses `@factstack/core` compiled via the WASM build pipeline (constraint C1 — isomorphic core means no source changes needed).
- Implements `@factstack/fs-browser` (also a v0.4 deliverable) to read repo content via the GitHub REST API instead of the filesystem.
- Scope-limited: analyzes a repo but cannot modify it. Cannot send code off the user's machine without explicit cloud-sync opt-in.

## Blocked on

- `@factstack/fs-browser` implementation.
- `@factstack/core` WASM build target (Rollup/Vite config).
- GitHub REST API rate-limit strategy (likely require a GitHub PAT for large repos).

## Open questions

- Should it work without a GitHub PAT at all? Anonymous rate limits are ~60 req/hr — not enough for a real repo scan. Probably: free tier = small repos only; PAT = unrestricted.
- Analysis budget: the extension shouldn't thrash a user's browser. Web Worker + file-count cap?
