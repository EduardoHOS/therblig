# Deferred work

Every entry records an intentional limit, why it is acceptable now, and the concrete
event that requires the full implementation. Remove an entry when its work ships.

## Atomic multi-operation patches

The benchmark API applies an array of operations directly to an in-memory moddle tree. A
later invalid operation can currently observe mutations made by earlier operations in the
same call. No shipped CLI, MCP server, or file writer exposes this behavior yet.

**Trigger:** before any external caller may submit more than one operation or before a
patched document can be written to disk. At that point, validate/apply against an isolated
document and publish the result only after every gate succeeds.

## TypeScript contracts

The core remains ESM JavaScript while the patch and projection APIs are still being
measured. Runtime validation is the authoritative boundary; a premature declaration file
would freeze vocabulary before the bake-off finishes.

**Trigger:** before publishing the library or exposing patch operations through MCP. Add
strict discriminated operation types without introducing a second implementation tree.

## Complete BPMN reference-integrity validation

The corpus gate proves parsing, XSD validity, recommended bpmnlint rules, and measured
diff properties independently. XSD validation does not resolve every BPMN reference, so
the repository does not yet claim a complete cross-reference integrity gate.

**Trigger:** before any patched document can be written to disk or returned by a public
API. Validate all BPMN references explicitly and reject dangling or cross-scope links
before publishing the result.

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
