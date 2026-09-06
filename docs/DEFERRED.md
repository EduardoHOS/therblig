# Deferred work

Every entry records an intentional limit, why it is acceptable now, and the concrete
event that requires the full implementation. Remove an entry when its work ships.

## Cross-file references

`calledElement` on a call activity, and `structureRef` on an item definition, may legitimately
name something in another file. The reference gate is single-file, so it does not judge them —
a dangling `calledElement` is reported by nothing today.

**Trigger:** the first command that opens more than one `.bpmn` at a time (a workspace, or
`extract` minting a called process). Resolve them across the loaded set and report what is
missing from it, without claiming anything about files that were never opened.

## MCP store persistence

Handles live in memory and die with the process, which the `open` tool's description states so a
model can see it before deciding to create state.

**Trigger:** a deployment that must survive a restart — a hosted server, or a client that reconnects
and expects its handles back. Until then persistence is a database for a process that has none.

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

## Plan-level placement

Designed as `placePlan`, and then not written: F12 measured 18 of 18 fork/file combinations
moving their shapes by a single delta with the existing per-element placement, because each new
element finds its room in the gap the first one opened. Branch rows are stacked without reflowing
what sits below them.

**Trigger:** the first fixture where a fork's stacked rows collide with a shape below, or where a
plan produces more than one distinct delta. Both are measured by the F9 gate, so the trigger
fires as a test failure rather than as a judgement call.

## DI after an op: retargeted edges and inverse geometry

`add … between` retargets an existing flow, but `placeNew` draws DI only for new ids, so the
existing edge keeps its waypoints and still ends at the old target — in the `insertAfter` diff,
`E_Flow_2` runs through the inserted shape. Semantics are right; the picture is stale. Separately,
an op's `inverse` restores the semantic tree and removes the DI of minted elements, but shapes
shifted to make room stay shifted; until a geometric undo exists, `git checkout` is that undo.

**Trigger:** plan-level placement (PR-06). `placePlan` re-routes every edge whose source or target
was placed or shifted, and records the pre-shift bounds so the inverse can restore them.
