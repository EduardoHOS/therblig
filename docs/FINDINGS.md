# Empirical findings

Every number here was produced by a script in this repo, on this machine, on the
dates given. Nothing is recalled or estimated. Re-run any of them yourself.

Environment: Windows 11, Node 22.23.2 (portable), `bpmn-moddle@10.2.0`,
`bpmn-auto-layout@2.0.0-alpha.2`, `bpmnlint@11.13.0`, `xmllint-wasm@5.3.0`.

Corpus: the 21 BPMN MIWG reference models (`Reference/*.bpmn`, pinned at
`cb26295`, 2026-03-11, CC BY 3.0) plus one hand-authored Camunda 8 file.

---

## F1 — bpmn-moddle round-trips Camunda 8 / Zeebe extensions losslessly

**2026-09-01 · `bench/scorer/probe-roundtrip.mjs`**

This was the day-one go/no-go for the moddle-as-source-of-truth architecture.
Parse → serialize a file carrying `zeebe:taskDefinition` (with `retries`),
`zeebe:ioMapping` (with FEEL expressions), `zeebe:taskHeaders`,
`zeebe:formDefinition`, `zeebe:assignmentDefinition`, `zeebe:versionTag`,
`modeler:executionPlatform`, and full DI.

**Result: 15/15 probes kept, 0 parser warnings.** The architecture holds.

## F2 — the corpus parses clean, and re-serialization is semantically exact

**2026-09-01 · `bench/corpus/profile.mjs`**

| measure | result |
|---|---|
| parse errors across 22 files | **0** |
| semantically identical after round-trip | **22/22** |
| idempotent (second pass byte-stable) | **22/22** |
| byte-identical to the original | **1/22** |

Byte-identity is the interesting one. moddle re-serializes the whole document, so
output matches the input bytes only when the input was written by a moddle-based
tool. The corpus spans nine different exporters (Signavio, Bonitasoft, W4, Camunda
Web Modeler, Camunda Modeler, …), so most files get reformatted.

## F3 — after normalization, an edit is a one-line diff and nothing moves

**2026-09-01 · `bench/corpus/probe-diff-floor.mjs`**

The promise under test: *"we only rewrite what you asked us to change."*
Normalize each file, change exactly one task's `name`, re-serialize, diff.

| measure | result |
|---|---|
| changed lines, one-attribute edit | **−1 +1 on all 22 files** |
| worst case (1,710-line, 94-node file) | **−1 +1** |
| `dc:Bounds` moved | **0 of 199** |
| normalization cost, Camunda-authored files | **−1 +2, −1 +2, −0 +0** |
| normalization cost, other exporters | full-file reformat |

So the honest contract is Prettier's bargain: **the first edit normalizes
formatting; every edit after that is minimal, and no shape ever moves.** Users
whose files come from Camunda Modeler pay essentially nothing even for that.

## F4 — bpmn-auto-layout fails on 41% of the OMG's own reference models

**2026-09-01 · `bench/scorer/probe-layout.mjs`, `probe-layout-detail.mjs`**

Strip all DI, run `layoutProcess`, then check DI *coverage*: every element that
needs a shape or edge must have got one. Silent partial layout is the failure that
ships broken diagrams, so coverage is the gate — not "no exception thrown".

| outcome | files |
|---|---|
| complete (100% shape and edge coverage) | **13 / 22** |
| incomplete — silent partial layout | **8 / 22** |
| hard crash | **1 / 22** |

Worst case `C.4.0`: **55 of 107 elements got no DI**, losing 3 of 4 participants
and everything inside them — with **zero warnings emitted**.

Confirmed against three input variants (raw, normalized, DI-stripped) with
identical results, so this is a layouter limitation, not a preprocessing artefact.

Failure modes, by cause:

- `bpmn:DataInput` / data associations are unsupported — throws
  `LayoutError: Cannot generate DI for visual BPMN element "bpmn:DataInput"` on
  raw input, silently drops `DataInputAssociation` / `DataOutputAssociation` otherwise
  (`C.7.0`, `C.8.1` — 29 associations lost)
- `bpmn:Group` unsupported: `GROUP_MEMBERS_NOT_FOUND`, and the group's members
  lose their DI too (`B.1.0`)
- multi-pool collaborations lose whole participants, silently (`C.4.0`)
- `A.4.0` crashes with a bare `TypeError: Cannot read properties of undefined
  (reading 'id')` — not a typed `LayoutError`, so it is not catchable by code

**The `warnings` channel does not reliably signal loss.** `C.4.0` lost 52 elements
and reported none. Any pipeline that relies on this package must run its own
coverage check.

### Why this reshapes the product

Every competitor in this space — Camunda's BPMN Copilot, `Stieges/bpmn-generator`,
BA Copilot — is built on the greenfield path: *text → whole diagram → auto-layout*.
That path rests on a layout engine that fails on 41% of the OMG working group's own
reference models.

Treadle's wedge is editing files that already have DI, where we place only new
elements next to their neighbours. That is roughly 200 lines we control, not a
layout engine we depend on. **The finding strengthens edit-first and weakens
generate-first**, which is the opposite of where the original plan put its weight.

## F5 — `bpmnlint:correctness` is a fair gate; `recommended` is a style opinion

**2026-09-01 · `bench/scorer/baseline.mjs`, `probe-presets.mjs`**

| preset | reference models passing |
|---|---|
| `bpmnlint:correctness` | **22 / 22** |
| `bpmnlint:recommended` | **9 / 22** (0/12 of the non-trivial ones) |
| `bpmnlint:all` | **0 / 12** |

The OMG's own reference models violate `recommended` 59% of the time — mostly
`label-required` (30), `no-bpmndi` (10), `end-event-required` (5).

Scorer consequence: **correctness is a hard pass/fail gate; recommended is only
meaningful differentially** — did this edit introduce style errors that were not
already in the file? Scoring an arm against absolute `recommended` cleanliness
would penalise it for the input file's pre-existing sins.

## F6 — the real reason for the Node 22.12 floor

**2026-09-01**

`bpmnlint@11.13.0` is CommonJS and `require()`s `min-dash@5`, which is ESM-only.
On Node 20.10 that is a hard `ERR_REQUIRE_ESM`. It works on Node 22.12+ only
because that release enables `require(esm)` by default.

`bpmn-auto-layout@2.0.0-alpha.2` declares `engines: { node: ">= 18" }` and does in
fact run correctly on Node 20.10 — so the Node floor comes from bpmnlint, not from
the layouter as previously assumed.

## F7 — the OMG XSDs validate the whole corpus

**2026-09-01 · `bench/scorer/gates.mjs`**

All five schemas fetched from `omg.org/spec/BPMN/20100501/` (200 OK, 73 KB total),
vendored unmodified under `third_party/omg/`, wired through `xmllint-wasm` with
relative `schemaLocation` resolution via `preload`.

**22/22 files validate.** The XSD gate is correctly calibrated — a failure means
the generated file is genuinely malformed, not that the gate is too strict.

Known ceiling: BPMN cross-references are mostly `xsd:QName`, which no schema
validator resolves. Only sequence-flow source/target are `xsd:IDREF`. Reference
integrity (dangling `attachedToRef`, missing `messageRef`, a participant pointing
at a nonexistent process) needs a hand-written pass over the moddle tree.

## F8 — BPMN stores adjacency twice, and moddle maintains only one side

**2026-09-01 · now enforced by `backend/core/adjacency.mjs` and
`backend/test/unit/patch.test.mjs`**

A sequence flow's connectivity lives in two places: on the flow
(`sourceRef` / `targetRef`) and on each endpoint node (`<incoming>` / `<outgoing>`
child elements). `moddle.create('bpmn:SequenceFlow', { sourceRef, targetRef })` sets
only the flow side. The result is a file that is XSD-valid and parses fine, but where
bpmnlint reports the new node as `no-disconnected`, `no-implicit-start` and
`no-implicit-end` — because the linter reads the node side.

This is the same structural hazard that makes text editing of BPMN unsafe, seen from
the other direction: **a flow id appears three times in the XML, so any mutation that
updates fewer than all three leaves the graph inconsistent.**

Fixed by routing every mutation through `linkFlow` / `unlinkFlow` / `retarget`, which
maintain both sides. Worth stating as a product invariant, not just a bug fix: no code
path may set `sourceRef` or `targetRef` directly.

## F9 — "made room" and "reflowed" are distinguishable, and that is the right gate

**2026-09-01 · `bench/scorer/gates.mjs`, now implemented by
`backend/core/placement.mjs`**

Inserting a node into a tight gap has to move downstream shapes — demanding zero
movement would be demanding overlapping diagrams. But making room is a **rigid
translation**: every shape that moves moves by the same delta. A relayout scatters
them into many different deltas.

So gate 5 tests `distinctDeltas <= 1`, not `shapesMoved === 0`.

Measured on incremental placement across four real files:

| file | shapes moved | distinct deltas | verdict |
|---|---|---|---|
| `handmade/zeebe-roundtrip` | 2 / 4 | 1 | made room |
| `miwg/C.9.1` | 0 / 11 | 0 | gap was wide enough |
| `miwg/C.9.0` | 17 / 26 | 1 | made room |
| `miwg/A.1.0` | 3 / 5 | 1 | made room |

All four stayed XSD-valid, `bpmnlint:correctness`-clean, introduced no new style
errors, and ended at 100% DI coverage.

## F10 — nothing in the toolchain checks a BPMN reference, and the corpus is 21/22 clean

Every case below is a hand-built document that is **XSD-valid and passes `bpmnlint:correctness`**.
The probe is `backend/test/unit/references.test.mjs`, which asserts both of those before asserting
that the reference gate catches the break — a rule that another gate already covers does not
belong in this one.

| broken reference | XSD | bpmnlint | `references` |
|---|---|---|---|
| sequence flow whose target does not exist | passes | passes | **catches** |
| boundary event attached to a missing id | passes | passes | **catches** |
| `BPMNEdge`/`BPMNShape` drawn for a missing element | passes | passes | **catches** |
| sequence flow reaching into a subprocess | passes | passes | **catches** |
| boundary event whose host is in another container | passes | passes | **catches** |
| lane claiming a node from another process | passes | passes | **catches** |
| gateway default flow that does not leave it | passes | passes | **catches** |
| duplicate element id | **catches** | passes | not a rule |

Duplicate ids are the XSD's job (the `ID` type) and are deliberately absent from the gate.
`calledElement` is also absent: a call activity legitimately names a process in another file, so
a single-file gate cannot judge it.

### The corpus

| measure | result |
|---|---|
| files with no reference findings | **21 / 22** |
| `miwg/C.7.0` | one `BPMNEdge` with no `bpmnElement` |

`C.7.0`'s orphan edge is XSD-legal — `bpmnElement` is optional in BPMNDI — and it is why the gate
is **differential** inside `scoreAll`, the same bargain as `bpmnlint:recommended` in ADR-006:
an edit is judged on the references it broke, never on the ones it inherited. The absolute
`references()` export still reports everything, which is what a `lint` command wants.

Reproduce:

```sh
node --test backend/test/unit/references.test.mjs
```

## F11 — deleting an element must delete what it contains, and the reference gate proves it

`miwg/C.4.0`'s `_aa275782…` user task carries an `inputOutputSpecification` with a `dataOutput`
and an `outputSet`, plus a `dataOutputAssociation`. Removing the task removed those with it — but
`del` reported none of them as changed and left the `BPMNEdge` that drew the association pointing
at nothing.

| measure | before | after |
|---|---|---|
| `noCollateral` unexpected ids on a `bypass` of that task | **3** | **0** |
| `references` findings introduced | **1** (`unresolved-reference`, a `BPMNEdge`) | **0** |

The bug predates the reference gate; the gate is what surfaced it on the first real-fixture edit.
Containment is `child.$parent === element` — `walk()` follows every reference and would have
reached the whole graph, so `document.mjs` grew a separate `contained()` for it.

Reproduce:

```sh
node --test backend/test/unit/ops-graph.test.mjs
```

### A note on `no-implicit-split` and message flows

Adding a message flow from a task that already has one outgoing sequence flow makes
`bpmnlint:recommended` report `no-implicit-split` on that task. BPMN does not split a token on a
message flow, so the rule is counting something that does not branch. The gate reports the style
delta rather than special-casing a linter rule; `recommended` is a style opinion (ADR-006), and
`correctness` stays green.

## F12 — a fork makes room, it does not reflow

F9 established that "made room" and "reflowed" are distinguishable: making room is a rigid
translation where every shape that moved moved by the same delta, and a relayout scrambles them
into many. The fork ops are the hardest structural edit in `bench/tasks/TASKS.md` — a split and a
join and two branches between them — so they are where that distinction had to be re-measured.

| file | `insertAfter` | `branch` | `parallel` | shapes / total |
|---|---|---|---|---|
| `handmade/zeebe-roundtrip` | 1 delta | 1 delta | 1 delta | 2 / 4 |
| `miwg/A.1.0` | 1 delta | 1 delta | 1 delta | 3 / 5 |
| `miwg/C.9.1` | 1 delta | 1 delta | 1 delta | 8 / 11 |
| `miwg/C.9.0` | 1 delta | 1 delta | 1 delta | 15–17 / 26 |
| `miwg/C.4.0` | 1 delta | 1 delta | 1 delta | 35–39 / 53 |
| `miwg/B.2.0` | 1 delta | 1 delta | 1 delta | 59–66 / 99 |

**18 of 18 combinations: one distinct delta, verdict "made room".** No plan-level placement pass
was needed — placing the minted elements one at a time already produces a single rigid shift,
because each new element finds its room in the gap the first one opened.

`B.2.0` is missing DI for 5 of its 185 elements before any edit and for the same 5 after: every
element the ops created got a shape or an edge. The gap is the file's, not the edit's.

Reproduce:

```sh
node --test backend/test/unit/ops-fork.test.mjs
```

## F13 — an op that adds an element must label it, or the model gets worse

Three ops mint elements that BPMN expects to carry a label, and the first end-to-end run of each
one failed `bpmnlint:recommended` for exactly that reason:

| op | element | rule |
|---|---|---|
| `branch` | the diverging gateway | `label-required` |
| `branch` | its conditional exit | `label-required` |
| `timeout` / `onError` | the boundary event | `label-required` |

All three now take a name and pass it through, and none of them invents one: an unlabelled
decision or handler is a model a reader cannot follow, and silently naming it for them would be
worse than the gate saying so.

Measured through the real entrypoint:

```sh
treadle apply p.bpmn --op timeout --args '{"on":"…","after":"P3D","to":"…"}'
# fail lintClean
treadle apply p.bpmn --op timeout --args '{"on":"…","after":"P3D","to":"…","name":"Too slow"}'
# ok   lintClean
```

The one style delta the ops do not fix is `no-implicit-split` on a message flow's source (F11),
which is bpmnlint counting something BPMN does not branch on.
