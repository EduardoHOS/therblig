# Architecture decisions

Short records. Each states the decision, what it rests on, and what would reverse it.
Findings referenced as F1–F7 live in [FINDINGS.md](FINDINGS.md).

---

## ADR-001 — The bpmn-moddle object tree is the source of truth

The IR is a lossy read-projection of the moddle tree for the model to reason over.
Patches apply to the moddle tree, not to the IR. Export re-serializes with moddle.

**Rests on:** F1 (Zeebe extensions survive untouched), F3 (a one-attribute edit is a
−1 +1 diff with zero shapes moved, on files up to 1,710 lines).

**Rejected:** IR-as-source-of-truth with the XML re-derived on export. Incremental
re-layout does not exist anywhere in the ecosystem, so that design moves every shape
on every edit — a catastrophic diff and instant distrust from anyone who owns the file.
It also requires a byte-provenance sidecar to preserve unmapped content, which the
moddle tree gives us for free.

**Reverses if:** we find a file where moddle silently drops content on round-trip.
Guard: the round-trip probe runs over the whole corpus in CI.

## ADR-002 — Original XML ids are carried verbatim; we mint ids only for new elements

**Rests on:** the human has the file open in Camunda Modeler where the element is
`Activity_0x8f2b1`. If the agent says it changed `t_validate`, every bug report becomes
a two-way id translation exercise. Minted ids slugified from labels are also unstable
under renaming, which is the operation that happens most.

**Reverses if:** measurement shows models materially fail to track opaque ids. Cheap to
test in the bake-off.

## ADR-003 — Edit-first, not generate-first

The wedge is reading, explaining, linting and editing files the user inherited. Greenfield
generation is supported but is not the pitch.

**Rests on:** F4 — full-file auto-layout fails on 41% of the OMG's own reference models,
including silent loss of 52 elements with zero warnings. Every competitor's product sits
on that path. Editing files that already have DI avoids it: we place only new elements
next to their neighbours, which is ~200 lines we control.

Also: analysts inherit models far more often than they draw them, and Camunda's Copilot
"officially supports only modifying diagrams that were created by the BPMN Copilot itself" —
so inherited files are explicitly unserved by the strongest incumbent.

## ADR-004 — Normalization is Prettier's bargain, stated up front

First edit reformats the file. Every edit after that is minimal.

**Rests on:** F2 (1/22 byte-identical, but 22/22 idempotent) and F3 (Camunda-authored
files cost −1 +2 lines to normalize; others get a full reformat).

Told to the user honestly rather than papered over: a `treadle fmt` command makes the
one-time diff a separate, reviewable commit instead of hiding it inside their first edit.

**Reverses if:** design partners reject the reformat. The fallback is a surgical XML
splicer that edits bytes in place — exact, but substantially harder.

## ADR-005 — DI coverage is a hard CI gate; the layouter's warnings channel is not trusted

Every layout call is followed by our own check that every element needing a shape or edge
got one. Build fails below 100%.

**Rests on:** F4 — `C.4.0` lost 52 of 107 elements and emitted zero warnings.

`bpmn-auto-layout@2.0.0-alpha.2` is pinned exactly and vendored. It is an unreleased alpha
under a `next` dist-tag from a package that ships no LICENSE file (MIT is declared in
`package.json` and README only). This is the single largest supply-chain exposure in the
project and is recorded as such, not as a footnote.

## ADR-006 — `bpmnlint:correctness` is a hard gate; `recommended` is differential

**Rests on:** F5 — the OMG reference models pass `correctness` 22/22 and `recommended`
9/22. Scoring anything against absolute `recommended` cleanliness penalises it for the
input file's pre-existing style violations.

## ADR-007 — Node 22.12 floor

**Rests on:** F6 — `bpmnlint@11.13.0` CJS-requires an ESM-only `min-dash@5`, which only
works where `require(esm)` is enabled. Not caused by the layouter, which runs fine on 20.

## ADR-008 — Apache-2.0, DCO, repo-level open-core boundary

Apache-2.0 for everything published. The commercial boundary is which repo code lives in,
never a license restriction on the core.

**Rests on:** the enterprise wedge is passing an MIT/Apache-only SCA gate with zero
exceptions — precisely the thing Camunda gave up when Camunda 8 Self-Managed moved to a
non-OSI license in October 2024 and Camunda 7 CE reached end of life. A source-available
core would burn the only structural advantage we have. Apache over MIT for the express
patent grant, in a space containing IBM, SAP, Pega and Software AG.

DCO over CLA: a CLA reads as intent to relicense, and this audience has just been burned
by exactly that. We are not planning to relicense the core, so we do not need the rights
a CLA would collect.

## ADR-009 — `bpmn-js` is quarantined, mechanically

Nothing in the published packages may depend on `bpmn-js`, `dmn-js`, `form-js` or
`cmmn-js`. Enforced by a dependency check plus a license allowlist in CI, not by convention.

**Rests on:** the bpmn.io license names exactly those four packages and requires the
watermark stay visible. `bpmn-moddle`, `moddle`, `moddle-xml`, `diagram-js` and `bpmnlint`
are verbatim MIT; the watermark is injected in `bpmn-js/lib/BaseViewer.js`, which a headless
pipeline never executes. An optional viewer package may depend on bpmn-js, published
separately, never bundled by the CLI, with the watermark obligation documented.

## ADR-010 — Stateless MCP with server-minted handles

No protocol sessions. State lives in our own store keyed by an opaque handle the model
passes as an ordinary tool argument, with `base_rev` for staleness and `patch_id` for
idempotency.

**Rests on:** MCP revision 2026-07-28 removed protocol-level sessions, the `initialize`
handshake, SSE resumability and sampling, and added an explicit "Stateful Tools" section
prescribing exactly the handle pattern. Because resumability is gone, a dropped stream
means the client re-issues the call — so every mutating tool must be idempotent or it
double-applies the edit.

Target `@modelcontextprotocol/server@2`, not the frozen v1 `@modelcontextprotocol/sdk`.

**Open:** how far back to support older spec revisions. 2026-07-28 shipped five weeks ago
and client lag is near-certain.

## ADR-011 — Ops compile intent to primitives; nothing above `patch.mjs` touches the tree

An op is a pure function `(IR, args) → envelope`. The envelope carries a `plan` of the four
primitives, its `inverse`, the ids it will mint, a `risk` level computed from the plan, a DI
`footprint`, and a one-sentence `explain`. Applying the plan is `applyPatch`'s job; the op never
imports the parser or creates a moddle object (guarded in `architecture.test.mjs`).

**Rests on:** the bake-off brief in `bench/tasks/TASKS.md` — every edit category is a question of
intent ("add a step where someone checks the documents"), and the primitives are permissive where
intent is strict: `add … after` on a node with two exits retargets both. The op refuses that with a
named remedy (`anchor-ambiguous — pass via: …`) before the primitive can guess. Testable with a
literal IR, so the ops layer costs no parser in its unit tests.

**Risk is computed, never declared:** `del` or `connect … remove` → `destructive`; `set` of `if`,
`default` or `to` → `routing`; `add`/`connect` → `additive`; else `safe`. A declared level would
drift from the plan; a computed one cannot.

**Reverses if:** an op cannot be expressed as primitives without a new primitive that only that op
uses. That is the signal the primitive set is wrong, not that the op should reach into the tree.

## ADR-012 — One block, one definition; a slot exists only where blocks differ

`backend/core/blocks/` holds one frozen definition per BPMN element type and `registry.mjs`
tabulates them. The table replaces three places that each listed types independently: the two
`Map`s in `vocabulary.mjs`, the `switch` arm in `patch.mjs` that turned an IR word into a moddle
type, and the `SIZE` table in `placement.mjs`. Adding a block was three edits that could drift;
it is now one object.

Slots today: `bpmn`, `ir`, `shape`, and the optional `also`, `project` and `build`. Each earns its
place by the anti-god-object rule — **a slot exists only if at least two blocks implement it
differently**. `ports`, `check` and `token` are named in the design but are absent here because
they have no consumer yet; they arrive with the op, lint and simulation work that reads them.

**Rests on:** the projection of all 22 corpus files is byte-identical before and after
(7,261 lines of IR), and `npm run corpus` output is unchanged.

**Two narrowings, both toward the spec:** the projection is now type-aware, so a user task no
longer reports `event` or `eventSubprocess` if something puts those properties on it — moddle's
schema does not give a user task either. And `placeNew` skips an element it has no block for
instead of inventing a 100x80 box: a pool or lane needs DI, but laying one out is a different
problem, and the closed vocabulary means `add` can never mint one. `diCoverage` still reports it
as missing, which is the honest answer.

**Reverses if:** a block needs a slot that only it implements. That is the signal the behaviour
belongs in the module that consumes it, not in the table.

## ADR-013 — Gates live in the core; the bench re-exports them

`backend/core/gates.mjs` owns parse, XSD, bpmnlint, collateral-change and diff-sanity;
`bench/scorer/gates.mjs` is now a re-export. The core may not import `bench/`, so a `propose`
that must not publish an unscored document needs the gates on its own side of the boundary.
The bake-off still scores every arm with exactly this code, which was the point of the split.

**Rests on:** `npm run corpus` output and the projection of all 22 files are unchanged, and the
schema path moved from a working-directory string to a module-relative URL — proven by a test
that validates the corpus with `process.cwd()` set to `/`, which the CLI will need.

**Three defensive shapes deleted after measuring the real ones:** `xmllint-wasm` 5.3.0 always
returns an `errors` array whose entries carry `message`, so the string/`rawMessage` fallbacks
never ran; and across the corpus's 1,167 references, moddle left zero as an unresolved string —
it drops a reference it cannot resolve — so `ref.id ?? ref` never ran either. That last fact is
also the reason a passing XSD gate says nothing about reference integrity, which is ADR-014's job.
`fingerprint` now walks with `document.mjs`'s `walk` instead of its own copy.

## ADR-014 — A proposal is a dry run against an isolated document

`propose(document, plan)` serializes and re-parses the caller's document (there is no deep clone
of a moddle tree, so a round-trip is the clone), applies the plan to that copy, places what it
created, scores every gate, and returns `{ ok, xml, gates, diff, created, changed, placed }`.
The caller's document is never mutated, so a plan that fails halfway leaves nothing behind, and
the error names which operation of how many failed.

**Rests on:** the guard test — a two-operation plan whose second operation is invalid leaves the
source byte-identical. Removing the isolation fails it.

**No `rev` yet.** The design pairs proposals with a revision handle, but no store exists: that
arrives with the MCP server, and a handle with no store to key would be a speculative field.
