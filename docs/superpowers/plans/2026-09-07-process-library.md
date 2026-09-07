# Process library home

## Intent and boundaries

Replace the explanatory landing page with a working process library. Keep the existing light default and remembered theme, BPMN reader, filesystem contract and installed Next 15 / React 19 stack. No new dependencies or invented process statuses, owners or modification dates.

## Plan

- [x] Search: inspect the home, workspace contract, file routing, styles and existing verification commands.
- [x] Test: add Node tests for folder selection, search, sorting, file metadata formatting and safe comparison links, including empty and special-character cases.
- [x] Code: replace `app/page.tsx` and `components/Index.tsx` with a responsive library shell, directory navigation, searchable table, sorting and explicit baseline/proposed comparison selection. Share URL encoding with the file rail and preserve the process page's existing decoding, verified against the installed Next runtime.
- [x] Verify: run the new tests with full model coverage, `make check`, frontend type checking and production build. Use the actual browser for desktop/mobile, light/dark persistence, search, empty results, folder selection, sorting, process navigation and comparison.
- [x] Review: inspect the complete diff and request an independent read-only code review; fix material findings.
- [x] Local delivery: leave reviewable changes in the existing checkout and report how to preview with `make dev`.

The user subsequently requested a commit and PR. Remote inspection found that the repository was renamed to `EduardoHOS/therblig` and current `main` diverges from this local Studio implementation. The user explicitly chose to publish the preceding 22 local commits together with the home redesign. The broader PR targets `main` as a draft; reconciling the two implementations remains a merge prerequisite, not a claim established by the branch's passing tests.

## Acceptance

The first screen identifies the workspace and its real BPMN files; processes open directly, folders and search compose, and sorting never mutates the input. Comparison requires two distinct existing files and clearly identifies the base and proposed versions. Controls have keyboard access and labels; the home fits a 390px viewport without page overflow. Default remains light even when the OS prefers dark.

Automated coverage will be measured for the new pure library behavior and the existing core/io. Browser verification complements that coverage; it does not establish 100% automated React component coverage.

## Verification results

- `make check`: 238 tests passed; core/io remained at 100% lines, branches and functions. Corpus and replay gates passed.
- `make build`: production build and frontend type validation passed; home first-load JavaScript is 109 kB.
- Targeted oxlint and `git diff --check`: passed.
- `node --test --experimental-test-coverage --test-coverage-include=frontend/lib/library.mjs --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 frontend/lib/library.test.mjs`: 8 tests; 100% lines, branches and functions.
- Browser: desktop and 390px mobile without horizontal page overflow, composed folder/search filtering, accent-insensitive search, all sort choices, empty results, Escape to clear, comparison selection and same-file rejection, actual diagram/review navigation, light default and remembered dark selection.
- Production browser: a workspace containing `vendas/Base 50% #1?.bpmn` and `Áprovação proposta.bpmn` opened and compared correctly. The installed Next version requires the existing route decoding; this was confirmed against the runtime rather than assumed from URL unit tests.
- Empty workspace, invalid BPMN failure and retry recovery were exercised with isolated temporary fixtures. No source BPMN was changed.
- Independent read-only review: no blocking findings. Semgrep's automatic configuration could not run with metrics disabled; an explicit local scan for dynamic code execution, raw HTML injection and shell execution returned no findings or parsing errors. This is narrower than the default security ruleset.

The existing workspace reader still fails the listing as a whole when any BPMN is invalid; the new home gives a recoverable error state. Reader confinement, semantic diff behavior and dependency upgrades are outside this frontend change.
