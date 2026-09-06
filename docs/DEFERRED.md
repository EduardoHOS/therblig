# Deferred work

Every entry records an intentional limit, why it is acceptable now, and the concrete
event that requires the full implementation. Remove an entry when its work ships.

## TypeScript contracts

The core remains ESM JavaScript while the patch and projection APIs are still being
measured. Runtime validation is the authoritative boundary; a premature declaration file
would freeze vocabulary before the bake-off finishes.

**Trigger:** before publishing the library or exposing patch operations through MCP. Add
strict discriminated operation types without introducing a second implementation tree.

## Cross-file references

`calledElement` on a call activity, and `structureRef` on an item definition, may legitimately
name something in another file. The reference gate is single-file, so it does not judge them —
a dangling `calledElement` is reported by nothing today.

**Trigger:** the first command that opens more than one `.bpmn` at a time (a workspace, or
`extract` minting a called process). Resolve them across the loaded set and report what is
missing from it, without claiming anything about files that were never opened.

## CLI and atomic file replacement

No CLI or file writer exists. Consequently, path confinement, temporary sibling writes,
fsync behavior, and atomic rename are documented requirements but have no implementation.

**Trigger:** the first command that accepts an input path or writes a `.bpmn` file.

## MCP handles and persistence

ADR-010 selects opaque handles, `base_rev`, and idempotent `patch_id` values, but no MCP
transport or document store exists.

**Trigger:** the first MCP tool. Start with an in-memory store; add persistence only when a
real deployment requires recovery across process restarts.

## Structured telemetry

The current benchmark scripts are short-lived local processes. Additional telemetry would
add configuration and dependencies without an operational consumer.

**Trigger:** a long-running MCP server or hosted process with an actual logging/metrics
destination. Until then, errors remain actionable and scripts exit non-zero on failure.

## Op ids are minted against the projection

`ops.mjs` mints ids against the id set of the IR, which omits ids the projection does not show
(event definitions, data objects, DI). A collision there makes `patch.mjs` re-mint at apply time,
and the envelope's `minted` and `inverse` then name an id that does not exist.

**Trigger:** `propose()` (gates in core, PR-03). It compares `applyPatch`'s `created` with the
envelope's `minted` and rejects the plan on mismatch instead of publishing a wrong inverse.

## DI after an op: retargeted edges and inverse geometry

`add … between` retargets an existing flow, but `placeNew` draws DI only for new ids, so the
existing edge keeps its waypoints and still ends at the old target — in the `insertAfter` diff,
`E_Flow_2` runs through the inserted shape. Semantics are right; the picture is stale. Separately,
an op's `inverse` restores the semantic tree and removes the DI of minted elements, but shapes
shifted to make room stay shifted; until a geometric undo exists, `git checkout` is that undo.

**Trigger:** plan-level placement (PR-06). `placePlan` re-routes every edge whose source or target
was placed or shifted, and records the pre-shift bounds so the inverse can restore them.
