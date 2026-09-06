# CLAUDE.md

Guidance for working in Treadle. These rules describe how the repository is built and
reviewed; they are requirements, not suggestions.

## What this is

Treadle is an offline, engine-neutral BPMN 2.0 editing core. It is intended to let a CLI,
an MCP server, and other callers read, explain, lint, and safely edit existing `.bpmn`
files without regenerating the whole diagram.

Status matters: the repository is still in its benchmark-first phase. `backend/core/`
contains the promoted structured-editing mechanism; the CLI, MCP server, and published
library do not exist yet. Do not describe planned surfaces as shipped.

## Layout

- `backend/core/` — the functional product core. No filesystem, CLI, network, or MCP I/O.
- `backend/test/` — all tests for the backend core, grouped by test kind.
- `bench/` — corpus, benchmark arms, probes, scorers, and task definitions.
- `docs/` — empirical findings, architecture decisions, deferred work, and plans.
- `third_party/` — vendored, provenance-recorded schemas.

Never add a generic `src/` directory. A product domain owns its code and tests directly:
`backend/`, or `frontend/` if a real frontend is introduced. Do not create empty domain,
package, adapter, CLI, MCP, or infrastructure scaffolds.

## The one rule

**No claim without reproducible evidence.** A correctness, compatibility, performance,
or diff-size claim must name the command or fixture that proves it. New findings include
their reproducer; changed behavior re-runs and updates the affected measurement.

## Core boundaries

- `document.mjs` owns parsing, serialization, traversal, indexing, and container lookup.
- `projection.mjs` owns the compact coordinate-free IR shown to an agent.
- `adjacency.mjs` is the only module allowed to assign `sourceRef`, `targetRef`,
  `incoming`, or `outgoing`.
- `patch.mjs` owns the four patch operations: `add`, `set`, `del`, and `connect`.
- `placement.mjs` adds DI for new elements and measures DI coverage.
- `vocabulary.mjs` owns the closed BPMN-to-IR node and event vocabularies.
- `index.mjs` is the backend core's public surface.

Benchmark modules may import or re-export the core. The core never imports `bench/`.

## Product invariants

- The `bpmn-moddle` object tree is the source of truth; the IR is a read projection.
- Preserve every existing XML id verbatim. Mint ids only for new elements.
- Route every adjacency mutation through `linkFlow`, `unlinkFlow`, or `retarget`.
- Never run full-file auto-layout on a document that already has DI.
- After an edit, every element requiring DI has DI; warnings from a layouter are not proof.
- Parsing, XSD validity, bpmnlint correctness, reference integrity, and collateral-change
  checks are independent gates. One passing gate cannot stand in for another, and XSD
  validity alone must never be reported as complete reference integrity.
- The first normalization may reformat a document; later edits must remain minimal.
- Errors identify the invalid operation and element without leaking document content.
- Never overwrite a user's BPMN file after a failed parse, patch, validation, or write.
- No production code depends on `bpmn-js`, `dmn-js`, `form-js`, or `cmmn-js`.

## Code conventions

- ECMAScript modules; prefix Node built-ins with `node:`.
- One clear responsibility per module; split only when a real second concern appears.
- Prefer small functions and plain data over class hierarchies.
- No abstraction with one implementation, speculative extension point, or new dependency
  for behavior already covered by Node or an installed package.
- Use one domain word for one concept. Names describe what a value is, not what it returns.
- Validate untrusted values at the first boundary and fail closed on unknown vocabulary.
- Closed vocabularies are constants or validated sets, never unchecked magic strings.
- Public errors start with a capital letter and contain an actionable reason.
- Comments explain a non-obvious invariant or measured constraint, not the syntax below.
- Record intentional shortcuts in `docs/DEFERRED.md` with their ceiling and activation
  trigger; remove the entry when the work is completed.

## Tests

- Use the built-in `node:test` runner and `node:assert/strict`.
- Tests live in `backend/test/{unit,integration,property,smoke}` as each kind becomes real.
- Unit tests are pure and fast. Integration tests exercise real parsers, validators, and
  committed BPMN fixtures. Smoke tests drive actual CLI/MCP entrypoints once they exist.
- A guard test must fail when the guard is removed. Exercise the production entrypoint,
  not a neighboring helper that cannot reproduce the failure.
- Cover happy paths, malformed inputs, unknown operations, missing references, duplicate
  ids, graph invariants, round-trips, large files, and dependency failures where relevant.
- Backend core coverage is 100% for lines, branches, and functions. If a line is truly
  unreachable or platform-specific, redesign it or explain the measured exception before
  lowering a gate.
- Keep fixtures deterministic. New external fixtures require provenance and a compatible
  redistribution license in `bench/corpus/PROVENANCE.md`.

## Commands

Use the lockfile and the repository scripts:

```sh
npm ci
npm run lint
npm test
npm run test:coverage
npm run corpus
npm run check
```

`npm run check` is the local and CI quality gate. Do not call a change complete if this
command is red or was not run after the final edit.

## Dependencies and security

- Search current primary documentation before changing an SDK, protocol, runtime floor,
  dependency, GitHub Action, license rule, or external contract.
- Pin dependencies and preserve the lockfile. Explain why each new dependency is needed.
- Keep GitHub Actions read-only unless a job explicitly requires more permission.
- Never commit secrets, credentials, private customer BPMN files, or production data.
- Treat file paths, XML, MCP arguments, handles, revisions, and patch ids as untrusted.
- When file writing exists, write a sibling temporary file, validate it, then atomically
  rename it over the target. Clean up the temporary file on every failure path.
- MCP logs go to stderr; stdout belongs to the protocol.

## Pull request pipeline

Follow these stages in order for every non-trivial change.

### 1. Search

1. Read `CLAUDE.md`, the relevant ADRs/findings, and the touched code and tests.
2. Run `git status --short --branch` and preserve unrelated local work.
3. Search every caller and invariant affected by the change with `rg`.
4. Consult current primary documentation for unstable external contracts.
5. Reproduce the current behavior or failure with the real fixture or entrypoint.

### 2. Plan

State the files, contracts, risks, observable success criteria, and runtime verification.
Prefer one cohesive change. Separate independent products into separate plans and PRs.

### 3. Test first

Write the smallest test that expresses the required behavior. Run it and confirm it fails
for the expected reason before editing production code. A passing or syntactically broken
test is not a valid red step.

### 4. Implement

Write the smallest production-safe change that turns the test green. Preserve document
content, ids, layout, error semantics, and public behavior outside the requested scope.
Do not add scaffolding, compatibility aliases, or dependencies without a current caller.

### 5. Verify

1. Run the targeted test.
2. Run `npm run check`.
3. Run the actual CLI or MCP operation when the change touches one of those surfaces.
4. For a BPMN mutation, inspect the produced file and the structural diff.
5. Re-run any benchmark or finding whose claim the change can affect.

### 6. Review

Review the full diff as an adversarial maintainer. Check silent corruption, partial writes,
dangling references, wrong DI, path traversal, unbounded input, dependency licenses,
performance on the large corpus, misleading names, and missing failure tests. Run
`git diff --check` and verify that generated files and secrets are absent.

### 7. Commit

Commit only when the user explicitly asks. Use cohesive conventional commits and DCO
sign-off, for example:

```sh
git commit -s -m "feat(core): make BPMN patch application atomic"
```

Never discard uncommitted work with destructive Git commands. Never stage unrelated
changes. Do not add AI attribution unless the user explicitly requests it.

### 8. Pull request

Create or update a PR only when explicitly asked. The title uses conventional-commit
style, is professional, describes the outcome, and never contains the term `codex`.

The PR body contains:

- problem and evidence;
- chosen design and rejected alternative when non-obvious;
- behavior and compatibility impact;
- exact verification commands and results;
- risks, migration, and rollback when applicable;
- linked ADR/finding/deferred entry updates.

Before opening it, confirm the branch is based on current `main`, commits are cohesive,
DCO sign-offs are present, CI-equivalent checks pass, and the diff contains only the
intended scope.

## Working style

- Recommend a path instead of listing unranked possibilities.
- Search first, plan second, code third, then verify the real behavior.
- Be explicit about assumptions, missing evidence, and residual risk.
- Never connect to GitHub, npm, or another external system without explicit approval.
- Never commit, push, open a PR, delete data, or rewrite history without explicit approval.
