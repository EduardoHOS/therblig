# Reconcile Studio and current main

Integrate main `7722884` into the PR branch without replacing either implementation's public contracts or dropping its regression tests. Canonical package identity is `therblig`; retain the existing `treadle` CLI/MCP commands alongside main's `therblig` commands because their contracts have real callers and tests.

- [x] Inspect both histories and reproduce the 14 conflicts with a non-committing merge.
- [x] Combine core exports, input guards, reference pruning and incremental DI placement; preserve registry-based operations and main's guarded write APIs.
- [x] Keep both MCP factories with independent tool sets and side-effect-free imports.
- [x] Reconcile manifests, lockfile, documentation and CI paths. Keep both validation workflows and the Studio's local dev/build flow.
- [x] Verify both test suites, 100% coverage gates, TypeScript, production frontend build, licence/pack checks, corpus sweep and actual Studio/browser plus CLI/MCP runtime.
- [x] Review the integration, commit the merge with sign-off, push and confirm PR mergeability against current main.

Dependency reconciliation keeps versions already selected by the two branches and makes runtime imports available to installed consumers. No source BPMN fixtures or production data should be overwritten during verification. Platform coverage exceptions, if any, must be explained rather than silently excluded.

## Integration evidence

- `make check`: 296 tests passed, with 100% lines, branches and functions across core, I/O and the frontend library model; lint, TypeScript, corpus baseline and replay passed. No coverage exclusions were added.
- `make build`: production Studio build passed; home first-load JavaScript remains 109 kB.
- `npm run oracle`: 24 files, zero errors and 12 inherited warnings. `npm run verify:corpus`: 144/144 edits, zero detached labels and orphan DI.
- Licence guard: 26 production packages passed. Pack audit: 77 files, 403 kB. An isolated installation of the final tarball ran both CLIs and imported both MCP factories and library entrypoints.
- Production browser: the Therblig home listed all 24 files, searched and opened C.8.0, and compared A.2.0 against A.2.1 through the actual controls without console errors.
- Independent review found two integration regressions, both fixed and covered: importing MCP through stdin/nonexistent host scripts, and newly introduced lint errors masked by repaired old errors. A subsequent independent review found no blocker in the lint correction.
- Semgrep's automatic MCP configuration could not run with metrics disabled. An explicit local dynamic-code/shell-execution rule scanned the six changed file-processing modules with zero findings and no parse errors; this is a limited check, complemented by manual boundary review and confinement/refusal tests, not the full registry ruleset.

Message flows now stay out of sequence-flow adjacency, removing the earlier implicit-split lint false positive. Vendor extension IDs no longer shadow BPMN elements: three C.8.0 regressions verify newly inserted elements survive XML serialization with complete DI. Path-based writes retain main's explicit-message-flow contract; legacy proposals retain automatic cross-pool message inference.

The checks do not establish 100% automated React component coverage or remove the pre-existing Studio confinement, invalid-file isolation and dependency-upgrade limitations described in the PR.

## Cross-platform follow-up

Merge commit `061ab3f` was pushed to PR #2, which GitHub reported as `MERGEABLE`. The first CI run passed the Studio build, Linux Node 22/24, corpus and packaging/license checks, then exposed Windows path conversion failures and a Node 22.12 test-import cycle. File URLs now use native conversion before filesystem/child-process calls; confinement verifies that a missing target's parent is a directory, including Windows' ENOENT behavior. The linter test waits until the BPMN modules have initialized before importing its CommonJS dependency.

The complete local gate then passed on the actual Node 22.12.0 runtime: 299 tests and 100% lines, branches and functions. Three new I/O regressions cover Windows error semantics, permission failures and atomic creation under a valid parent. The write-interruption test now imports through a file URL and confirms that a real, valid edit reached the pre-rename boundary before sending SIGKILL; startup failure or a refused edit can no longer produce a false pass. The remote matrix must validate these portability changes on its Windows runners.
