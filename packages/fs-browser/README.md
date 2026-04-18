# @factstack/fs-browser *(v0.4 stub)*

**Not built in v0.1.** Reserved for the Chrome-extension / web-app surface in v0.4+.

Will implement the `FactsFS` interface from `@factstack/spec` using:
- File System Access API for local directories (web app, v0.5).
- GitHub REST API for public repos browsed from the Chrome extension (v0.4).

Exists in the monorepo today so that constraint C1 (isomorphic core) has a concrete consumer in mind as the core packages evolve. When this package materializes, no changes should be required in `packages/core`, `packages/walker`, or any extractor/scanner — only this adapter.
