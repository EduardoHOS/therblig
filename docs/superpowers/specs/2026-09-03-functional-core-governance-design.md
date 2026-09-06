# Functional Core and Repository Governance Design

## Goal

Promote Treadle's structured BPMN prototype into a production-shaped functional core,
keep tests inside the `backend/` domain, and make the repository's development and pull
request rules explicit and mechanically checked.

## Constraints

- Product code lives under `backend/`; there is no generic `src/` directory.
- Product tests live under `backend/test/`.
- `bench/`, `docs/`, and `third_party/` remain at the repository root.
- No empty frontend, CLI, MCP, package, adapter, or infrastructure scaffolds are added.
- Node 22.12 remains the supported runtime floor.
- Existing BPMN behavior and benchmark results must remain unchanged.
- No commit, push, or pull request is created unless explicitly requested.

## Architecture

The repository uses a functional core with thin external shells. The core owns BPMN
parsing, serialization, traversal, projection, graph mutation, and incremental diagram
placement. It does not read files, parse command-line arguments, or speak MCP.

```text
backend/
  core/
    document.mjs
    projection.mjs
    adjacency.mjs
    patch.mjs
    placement.mjs
    vocabulary.mjs
    index.mjs
  test/
    unit/
    integration/

bench/
docs/
third_party/
```

`bench/arms/ir.mjs` and `bench/arms/place.mjs` remain only as compatibility exports so
existing benchmark commands and historical references do not break. They contain no
business implementation.

## Core boundaries

- `document.mjs` owns moddle parsing, serialization, traversal, indexing, and container
  lookup.
- `projection.mjs` creates the compact, coordinate-free IR.
- `adjacency.mjs` is the only module allowed to mutate `sourceRef`, `targetRef`,
  `incoming`, or `outgoing`.
- `patch.mjs` applies the four supported operations: `add`, `set`, `del`, and `connect`.
- `placement.mjs` adds DI only for new elements and measures DI coverage.
- `vocabulary.mjs` owns the closed BPMN-to-IR node and event vocabularies.
- `index.mjs` is the public core surface.

No class hierarchy or port is introduced until a second real implementation requires
one. Future CLI and MCP entrypoints must depend on `backend/core/index.mjs`, never on
benchmark modules.

## Tests and quality gates

The hand-written self-test runner is replaced by Node's native test runner and strict
assertions. Tests live inside `backend/test/` and cover:

- projection and preservation of original identifiers;
- every patch operation and actionable failures;
- graph adjacency on both the flow and endpoint sides;
- incremental placement and 100% DI coverage;
- XSD, bpmnlint correctness, no collateral structural edits, and rigid layout movement;
- the complete existing BPMN corpus through the existing benchmark gate.

Coverage for `backend/core/**/*.mjs` is required to be 100% for lines, branches, and
functions. `npm run check` is the single local and CI entrypoint for lint, coverage, and
corpus integrity.

Oxlint is fixed at `1.81.0`: it supports the repository's Node 22.12 floor. ESLint 9 was
rejected because it is no longer supported, and ESLint 10 requires Node 22.13 or newer.

## Agent governance

`CLAUDE.md` is the detailed repository guide requested for this project. `AGENTS.md` is
the tool-neutral entrypoint and explicitly routes every agent to the same canonical
guide, avoiding duplicated rules that can drift.

The pull request pipeline is:

1. search current repository context and relevant primary documentation;
2. state a short plan and observable success criteria;
3. write a failing test for behavior changes;
4. implement the smallest production-safe change;
5. run the targeted test, then `npm run check`;
6. run the real CLI/MCP flow when those surfaces exist;
7. review the complete diff for correctness, security, silent corruption, licensing,
   performance, and test gaps;
8. prepare cohesive conventional commits with DCO sign-off only when requested;
9. create a professionally named PR that never contains the term `codex`, only when
   explicitly requested.

## Deferred decisions

TypeScript, CLI packaging, MCP transport, persistent document storage, and telemetry are
not introduced by this change. Each needs a concrete product surface first. Known
ceilings and their activation triggers are recorded in `docs/DEFERRED.md`.
