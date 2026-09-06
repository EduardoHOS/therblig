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

**Resolved:** `@modelcontextprotocol/server@2.0.0` is published and `serveStdio` handles the era
decision itself — its `legacy: 'serve'` default pins a 2025-era instance from the same factory for
a connection that opens with an `initialize` request, so supporting older clients costs nothing
and needs no code of ours. Verified against the real wire before any of this was built: a spike
answered `tools/list` and `tools/call` over stdio with `resultType: "complete"` and no handshake.

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

## ADR-015 — Reference integrity is its own gate, and it is differential

`references(xml)` resolves every BPMN reference and checks scope: a sequence flow may not cross a
container, a boundary event may not attach across one, a lane may not claim a node from another
process, and a default flow must leave the element that names it. Only a message flow may cross.

**Rests on:** F10 — seven broken documents, each XSD-valid and `bpmnlint:correctness`-clean, and
none of them caught by anything else. This is the measured form of the invariant that XSD validity
must never be reported as complete reference integrity.

**Differential inside `scoreAll`, absolute on its own.** `miwg/C.7.0` ships a `BPMNEdge` with no
`bpmnElement`, which BPMNDI permits; blocking every edit to that file would repeat the mistake
ADR-006 already names. A proposal fails on what it broke, not on what it inherited.

**Not rules here:** duplicate ids (the XSD's `ID` type catches them) and `calledElement` (a call
activity may legitimately name a process in another file — a workspace concern, not a file one).

**Reverses if:** a corpus file trips a scope rule that BPMN actually permits. The gate is then too
strict and the rule, not the file, is wrong.

## ADR-016 — A connection's kind is decided by scope, not by the caller

`connect` mints a sequence flow when source and target share a container and a message flow when
they do not, refusing when the two containers are not pools of one collaboration. BPMN leaves no
choice here — within a container a connection is a sequence flow, across pools it can only be a
message flow — so choosing for the caller adds no ambiguity and removes a way to be wrong.

**Rests on:** `miwg/C.4.0` gives every pool its own single-participant collaboration, so there is
no one place a message flow between two of its pools could live; guessing would put it in an
arbitrary parent. `miwg/C.1.0` has two pools under one collaboration and works.

**Also:** `set { lane }` moves a node between lanes, because lane membership lives on the lane
(`flowNodeRef`) and not on the node — the IR shows it on the node, so the primitive mirrors the
IR rather than making a caller edit two lanes.

## ADR-017 — An op guarantees an exact inverse; a primitive does not

`bypass` refuses a node carrying boundary events instead of cascading them, because the IR does
not carry a timer's duration or an error code and the re-added boundary could not be restored.
An inverse that silently drops data is worse than a refusal that names the remedy: remove the
boundary first, or use `del` and accept the loss.

**Rests on:** the envelope promises `inverse`, and every op test applies plan then inverse and
compares the semantic fingerprint. A lossy inverse would pass that check while losing content.

**`risk` counts `lane` as routing.** Moving a step between lanes moves no token, but it changes
who executes the work — not something an autonomous agent should do unreviewed.

## ADR-018 — A fork mints its split and join as a pair

`branch` and `parallel` create both gateways in one plan and return `{ split, join }`, so an
unbalanced gateway stops being expressible at this height. The first branch consumes the direct
split-to-join flow that `add … between` leaves behind, which is why that flow is always the one a
default can name; every later branch is connected explicitly.

**Rests on:** F12 — 18 of 18 file/op combinations move their shapes by a single delta, so the
gate that distinguishes "made room" from "reflowed" stays green on the hardest edit in the brief.
Plan-level placement was designed and then not written: it had no measured problem to solve.

**`branch` is `routing`, not `additive`.** Its plan sets a default, and the risk level is computed
from the plan rather than declared by the op — inserting a decision into a path that had none is
exactly the kind of change a human should see.

**The op never invents a label.** A diverging gateway and its conditional exit read as unlabelled
decisions without one, and bpmnlint says so; `branch` takes `name` and `label` and passes them
through, but makes nothing up when they are absent.

**Minted ids lead with the kind** — `xor_split_<anchor>`, not `<anchor>_xor_split` — because
`mintId` truncates a slug at 24 characters and real ids are long: the truncated form still says
what the element is instead of reading as the anchor's own id.

## ADR-019 — `backend/io` is the only filesystem boundary, and it confines by real path

`confine(root, path)` resolves through `realpath`, so a `..` and a symlink pointing out of the
workspace are refused by the same check, and the resolved path is what every later operation uses.
An absent target is confined by its directory, because a write target does not exist yet;
anything other than `ENOENT` surfaces as itself rather than as a confinement failure.

`writeBpmnAtomic` writes a sibling temporary, `fsync`s it, re-reads it from disk and parses what
actually landed, and only then renames over the target. The rename is the single step that touches
the user's file, and it is atomic — so a failure at any earlier step leaves that file byte-identical.
Cleanup runs on every throwing path and is best effort: it must never turn a real error into a
confusing one, and it must never remove something the write did not create.

**Rests on:** eight failure paths under test, each asserting the target is unchanged and the
directory holds no leftovers — including a directory squatting on the temporary's name.

**Guarded, not conventional:** an architecture test asserts no core module imports `node:fs` or
`backend/io`. The one exception is `gates.mjs`, which reads the vendored OMG schemas that ship
with the module and are not user input. `backend/io` is now under the same 100% coverage gate as
the core.

## ADR-020 — The CLI reads before it writes, and confines to the working directory

`treadle project`, `lint` and `explain` ship first, with no write path at all. They need none of
the machinery a writer does, so they are the shortest route to something someone can actually run,
and a smoke test asserts that none of the three leaves a byte behind.

Paths are confined to `process.cwd()`, widened by `--root`. CLAUDE.md treats a file path as
untrusted, and a human at a terminal is only trusted until an agent is driving the same binary;
the refusal names the flag that widens the workspace, so the safe default is not a dead end.

`explain` calls no model. Everything it prints is derived from the IR, so the same file always
gives the same bytes and two explanations can be diffed. It reports what a reader cannot see by
looking: the handlers attached to each activity, what can never run, and what never ends.

**Reachability accounts for how a node really runs.** Seeding from start events alone reported
four of `C.9.0`'s nodes as unreachable, and all four were lies: two are event subprocesses, which
are triggered by their own start event and have no incoming flow by definition, and the other two
sit downstream of an error boundary, which fires when its host runs. The walk seeds from triggered
nodes and wakes a boundary whose host it has reached, to a fixed point.

**Not under the line-coverage gate.** The smoke suite spawns the real entrypoint, and coverage is
not collected across processes. Every command, exit code and failure path is covered by a spawned
test instead — which is stronger evidence for a CLI than a line count.

## ADR-021 — Dry run by default; `--write` publishes, `--allow` decides how far

`treadle apply` prints the envelope, every gate and the measured diff, and touches nothing. Adding
`--write` publishes through `writeBpmnAtomic`, and only if every gate passed. The risk level is
computed from the plan, so the policy needs no per-op table: `--allow` defaults to `safe,additive`
and a plan above it exits 3 naming both the level and the flag that would permit it.

That default is the answer to "what may an agent change unreviewed": the edits that only add.
A `routing` or `destructive` plan is still printed in full — the refusal is about publishing, not
about looking.

**`fmt` is its own command** so the one-time reformat of ADR-004 lands in its own commit instead
of hiding inside whatever edit came first. It reports the diff between the bytes on disk and the
normalised form — the first implementation compared two already-normalised forms and reported
`−0 +1` while rewriting the file, which is now a test.

**No `undo` command.** The inverse is already in the envelope; `apply --plan inverse.json` runs it.
A command for what an argument already does is a command to keep working.

**Ops are named by an explicit map, and `--args` takes JSON.** One flag carrying the op's arguments
maps to the envelope's `args` exactly, instead of inventing a flag per parameter of ten ops.

## ADR-022 — TypeScript contracts are emitted from JSDoc, never hand-written

`npm run types` runs `tsc --emitDeclarationOnly` over `backend/core` and `backend/io` and then
type-checks `backend/contracts/consumer.ts` against what came out. There is no second
implementation tree, which was the condition the DEFERRED entry set: the types live in the JSDoc
of the module that owns the concept, and `index.mjs` re-declares them so a consumer imports
everything from one place.

**Rests on:** the consumer resolves `treadle` through a `paths` mapping to the emitted `.d.mts`,
so it exercises the declarations rather than the JavaScript they came from. Its three
`@ts-expect-error` directives are the guard, and a self-verifying one: widening `Operation` to
accept any object makes `tsc` report the directive as unused and `npm run types` fail. Measured by
doing it.

**`checkJs` stays off.** Runtime validation is the authoritative boundary — a closed vocabulary
that fails on an unknown word, and gates that refuse to publish. The declarations describe that
contract for a caller; they do not replace it.

**`types/` is not committed.** It is built by `npm run check`, and a generated tree in git is a
tree that drifts.

## ADR-023 — The MCP server proposes freely and publishes under a policy

Every op tool is a dry run: it returns the plan, its exact inverse, the computed risk, every gate
and the measured diff, and mints a revision. `publish` is the only tool with a side effect, and it
refuses two things — a revision that failed a gate, and one whose risk is above the server's
allowance (`TREADLE_ALLOW`, default `safe,additive`). Proposing is always permitted: the refusal is
about writing, not about looking, and a model that can see the full plan of a destructive edit can
explain it to the human who has to approve it.

**Handles are opaque and state is ours.** The protocol has no session — the spec's own "Stateful
Tools" section says a handle is an ordinary string in a tool result and an ordinary argument
afterwards. `open` mints a UUID, and a handle that encoded the path would invite guessing at
another one.

**Every mutating tool takes `base_rev` and `patch_id`.** Resumability is gone from the protocol, so
a dropped stream means the client re-issues the call; a tool that is not idempotent double-applies
the edit. A repeated `patch_id` returns the first result without re-applying, and a stale
`base_rev` is refused naming the revision that is current.

**A precondition refusal is a tool error, not a protocol error.** The spec says clients SHOULD feed
tool execution errors to the model for self-correction and MAY feed protocol errors, which are
"less likely to result in successful recovery". So `anchor-ambiguous — pass via: F1 | F2` comes
back as `isError: true` with the remedy in it, and only an unknown tool is a JSON-RPC error.

**Rests on:** eleven smoke tests that spawn the real binary and speak JSON-RPC over stdio,
including one asserting every line of stdout is a protocol message.

**The SDK stays in `backend/mcp`.** An architecture test asserts the core, `backend/io` and the CLI
never mention `@modelcontextprotocol`, so the protocol is a delivery surface and not a dependency
of the product.

## ADR-024 — A semantic rule ships only with proof that nothing else catches it

The `semantics` gate holds one rule. Two other candidates were built, measured, and dropped
because `bpmnlint` already catches them (F16). A gate that repeats another gate costs the same to
run and teaches a reader that a finding is our own when it is not.

The test for each rule constructs the document it should catch and asserts XSD validity and both
bpmnlint presets pass it *before* asserting this gate does not — so a rule that stops being ours,
because a linter grew it, fails the suite rather than quietly duplicating.

**No `check` slot on the block table.** One rule on one block would be a slot with a single
implementation, which ADR-012 rules out. The rule lives in the module that consumes it, and moves
to the table when a second block needs one.

## ADR-025 — Discrete-event tokens, and a refusal wherever the model needs more than a node knows

Every token carries its own clock. A node fires at the latest arrival among the tokens it
consumes, so a parallel join takes the longer branch — 4 hours beside 9 is 9, and a running global
clock would have said 13.

**Durations live in the file**, as `<treadle:duration p50="PT4H"/>` in `extensionElements`. moddle
round-trips an unknown extension element and its attributes untouched, measured, so this needed no
moddle descriptor and no dependency. They are versioned with the process and survive every other
tool that opens it.

**Conditions are never evaluated.** Evaluating FEEL or JUEL would tie this to an engine. The
caller says which paths are taken, keyed by a flow's condition, its id, or its label — because
every exclusive gateway in the corpus documents its decision with a label and none carries a
condition. Weights on one gateway are a distribution, not independent draws.

**Four ways to stop, and all four are said out loud:** `unsupported` (an inclusive join, a complex
gateway — each needs information no node carries alone), `undecided` (a gateway the scenario did
not decide), `deadlocks`, and `unbounded` (a loop the scenario never exits, bounded by a step
budget so a simulator never hangs). `p50` is `null` unless all four are empty: a number beside a
warning gets quoted without the warning.

**Reverses if:** a model needs sub-scope simulation to be useful. A subprocess runs as one opaque
step today, which is a stated limit rather than a hidden one.
