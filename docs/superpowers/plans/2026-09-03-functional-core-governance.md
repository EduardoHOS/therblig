# Functional Core and Repository Governance Implementation Plan

> **For agentic workers:** Execute inline and task-by-task. Do not dispatch subagents for
> this repository-wide move because the files share imports and ownership.

**Goal:** Move the BPMN implementation into `backend/core`, formalize its tests under
`backend/test`, and enforce repository and PR rules through documentation and CI.

**Architecture:** A dependency-light functional core owns BPMN behavior. Benchmark files
may consume or re-export the core but may not implement it. No generic `src/` directory or
empty product surface is created.

**Tech Stack:** Node.js 22.12+, ESM, `node:test`, native Node coverage, bpmn-moddle,
bpmnlint, xmllint-wasm, Oxlint 1.81.0.

## Global Constraints

- Keep `bench/` and `docs/` at repository root.
- Keep all product tests inside `backend/test/`.
- Preserve all existing BPMN behavior and corpus results.
- Require 100% line, branch, and function coverage for `backend/core`.
- Do not commit, push, or create a PR without explicit user instruction.

---

### Task 1: Add repository governance and quality commands

**Files:**

- Create: `AGENTS.md`
- Create: `CLAUDE.md`
- Create: `docs/DEFERRED.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`

- [x] Install exact development dependency `oxlint@1.81.0`.
- [x] Define lint rules for repository JavaScript without format churn.
- [x] Define `test`, `test:coverage`, `corpus`, `lint`, and `check` scripts.
- [x] Make the CI test job call the same `npm run check` entrypoint used locally.
- [x] Document the search-plan-test-code-verify-review-ship PR pipeline.

### Task 2: Write formal tests against the intended core surface

**Files:**

- Create: `backend/test/unit/document.test.mjs`
- Create: `backend/test/unit/projection.test.mjs`
- Create: `backend/test/unit/patch.test.mjs`
- Create: `backend/test/unit/placement.test.mjs`
- Create: `backend/test/integration/corpus.test.mjs`
- Create: `backend/test/support/fixture.mjs`

**Interfaces:**

- Consume from `backend/core/index.mjs`: `parse`, `serialize`, `project`,
  `applyPatch`, `placeNew`, and `diCoverage`.
- Use real BPMN fixtures from `bench/corpus/`; no mocked moddle tree.

- [x] Write Node tests that express all existing self-test behavior.
- [x] Add direct assertions that both sides of graph adjacency remain consistent.
- [x] Add rejection tests for unknown operations, node types, containers, hosts,
  sources, and targets.
- [x] Run `node --test` and confirm failure because `backend/core/index.mjs` does not
  exist yet.

### Task 3: Move the implementation into the functional core

**Files:**

- Create: `backend/core/document.mjs`
- Create: `backend/core/projection.mjs`
- Create: `backend/core/adjacency.mjs`
- Create: `backend/core/patch.mjs`
- Create: `backend/core/placement.mjs`
- Create: `backend/core/vocabulary.mjs`
- Create: `backend/core/index.mjs`
- Replace: `bench/arms/ir.mjs` with compatibility exports
- Replace: `bench/arms/place.mjs` with compatibility exports
- Modify: `bench/tasks/inventory.mjs`

- [x] Extract document traversal and indexing without changing behavior.
- [x] Make adjacency mutation available only through the dedicated module.
- [x] Move projection, patch, placement, and DI coverage into focused modules.
- [x] Run targeted tests until all are green.
- [x] Remove duplicate implementation from `bench/arms`.

### Task 4: Retire the ad-hoc test runner and enforce the gates

**Files:**

- Delete: `bench/arms/ir-selftest.mjs`
- Delete: `bench/arms/place-selftest.mjs`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`

- [x] Point contributor commands and architecture documentation at `backend/`.
- [x] Run `npm run lint` and fix only actionable diagnostics.
- [x] Run `npm run test:coverage` and add the smallest missing behavioral tests until
  backend core coverage is 100%.
- [x] Run `npm run corpus` and confirm 22/22 parse and XSD validation.
- [x] Run `npm run check` as the full local runtime-equivalent gate.

### Task 5: Review the complete change

- [x] Review `git diff --check`, `git diff --stat`, and the complete diff.
- [x] Confirm no implementation remains under `bench/arms`.
- [x] Confirm no `src/`, empty frontend, CLI, or MCP scaffold was created.
- [x] Confirm dependencies remain free of the four prohibited bpmn.io packages.
- [x] Confirm no secrets, generated coverage, or `node_modules` files are tracked.
- [x] Report verification evidence and residual deferred work without committing.
