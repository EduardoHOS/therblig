# Empirical findings

Every number here was produced by a script in this repo, on this machine, on the
dates given. Nothing is recalled or estimated. Re-run any of them yourself.

Environment: Windows 11, Node 22.23.2 (portable), `bpmn-moddle@10.2.0`,
`bpmn-auto-layout@2.0.0-alpha.2`, `bpmnlint@11.13.0`, `xmllint-wasm@5.3.0`.

Corpus: the 21 BPMN MIWG reference models (`Reference/*.bpmn`, pinned at
`cb26295`, 2026-03-11, CC BY 3.0) plus one hand-authored Camunda 8 file.

## Evidence scope after the Studio merge

F1–F17 below preserve the corrected `origin/main` record at `7722884`. The Studio
branch at `eee02c3` independently numbered different findings F10–F17; those are
retained as **Studio F10–Studio F17** at the end, and their cross-references are
qualified. Unqualified F1–F9 refer to the shared findings and their corrections.

All measurements here are historical. Dates, operating systems, Node versions,
corpus sizes and script paths describe the original runs, not a verification of the
merged checkout. In particular, Studio F12's rigid-shape result does not establish
label preservation: F11 documents why that instrument could miss detached labels.
Rerun the named probes and current quality gates before making a merged-branch claim.

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

Worst case `C.4.0`: **52 of 107 elements got no DI**, losing 3 of 4 participants
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

### Version scope (added 2026-09-04)

Every number above is a measurement of **`bpmn-auto-layout@2.0.0-alpha.2`**, published
2026-07-24. Verified today: that is still the newest published build — npm dist-tags are
`latest: 1.3.0` (2026-03-11) and `next: 2.0.0-alpha.2` — so the finding is current, but
it is a fact about one unreleased alpha and must be cited that way in public. Upstream
work landed after that publish is unmeasured here.

The deeper claim is version-independent and is the one worth repeating: **the `warnings`
channel does not signal loss.** That is a property of the package's error contract, not
of which BPMN constructs it happens to support this month. Any pipeline depending on it
must run its own coverage check regardless of version.

Two supply-chain facts, also verified today: the published tarball ships **no LICENSE
file** (`node_modules/bpmn-auto-layout/` contains none), and its only grant is the
string `"license": "MIT"` in `package.json`. Since no published version has ever shipped
one, downgrading to the `latest` stable 1.3.0 is **not** a mitigation for that.

### Why this reshapes the product

Every competitor in this space — Camunda's BPMN Copilot, `Stieges/bpmn-generator`,
BA Copilot — is built on the greenfield path: *text → whole diagram → auto-layout*.
That path rests on a layout engine that fails on 41% of the OMG working group's own
reference models.

therblig's wedge is editing files that already have DI, where we place only new
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

**2026-09-01, re-checked 2026-09-04**

`bpmnlint@11.13.0` is CommonJS and `require()`s `min-dash@5`, which is ESM-only.
On Node 20.10 that is a hard `ERR_REQUIRE_ESM`. It works on Node 22.12+ only
because that release enables `require(esm)` by default.

`bpmn-auto-layout@2.0.0-alpha.2` declares `engines: { node: ">= 18" }` and does in
fact run correctly on Node 20.10 — so the Node floor comes from bpmnlint, not from
the layouter as previously assumed.

**2026-09-04 re-check.** Both halves reproduce exactly. On Node 20.10:
`import('bpmnlint/lib/linter.js')` throws `ERR_REQUIRE_ESM` on `min-dash/dist/index.js`;
`import('bpmn-auto-layout')` resolves cleanly and exports `LayoutError`,
`LayoutWarning`, `layoutProcess`. On Node 22.20, `bench/scorer/gates.mjs` imports fine.

One correction to the *reasoning*, which does not change the number. `bpmnlint@11.13.0`
itself declares `engines: { node: ">= 20" }`, and Node's changelog puts the unflagging
of `require(esm)` at **20.19.0**, not 22.12 — so the floor this dependency chain
strictly forces is 20.19. (Measured here: 20.10 fails, 22.20 works. The 20.19 boundary
itself is not measured on this machine.)

**So 22.12 is a chosen floor, not a forced one** — it is where `require(esm)` is
unflagged on the 22 LTS line — and it should be stated as a choice. A claim considered
and rejected on the evidence: that `bpmn-auto-layout` 2.x forces 22.12. The installed
package declares `>= 18` and imports successfully on 20.10, as above.

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

**2026-09-01 · `bench/arms/ir.mjs`, found by `place-selftest.mjs`; now enforced by
`backend/core/adjacency.mjs` and `backend/test/unit/patch.test.mjs`**

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

## F9 — "made room" and "reflowed" are distinguishable — **SUPERSEDED by F11**

**2026-09-01 · `bench/scorer/gates.mjs`, `bench/arms/place.mjs`**
**Superseded 2026-09-04. The distinction below is sound. The measurement was not.**

Inserting a node into a tight gap has to move downstream shapes — demanding zero
movement would be demanding overlapping diagrams. But making room is a **rigid
translation**: every shape that moves moves by the same delta. A relayout scatters
them into many different deltas.

So gate 5 tests `distinctDeltas <= 1`, not `shapesMoved === 0`.

Measured on incremental placement across four real files. The final column was added
on 2026-09-04 by `bench/probe/probe-labels.mjs` and did not exist when this table was
first published:

| file | shapes moved | distinct deltas | verdict | **labels left behind** |
|---|---|---|---|---|
| `handmade/zeebe-roundtrip` | 2 / 4 | 1 | made room | **0** |
| `miwg/C.9.1` | 0 / 11 | 0 | gap was wide enough | **0** |
| `miwg/C.9.0` | 17 / 26 | 1 | made room | **9** |
| `miwg/A.1.0` | 3 / 5 | 1 | made room | **3** |

All four stayed XSD-valid, `bpmnlint:correctness`-clean, introduced no new style
errors, and ended at 100% DI coverage — and two of the four silently detached every
external label on every shape that moved. See F11.

## F10 — moddle silently drops the XML constructs it does not model

**2026-09-04 · `bench/probe/probe-conserve.mjs`**

`moddle-xml` registers saxen handlers for `openTag`, `question`, `closeTag`, `cdata`,
`text`, `error` and `warn` — and never for `comment` or `attention`. So XML comments,
DOCTYPE declarations and every processing instruction other than the XML declaration
are discarded on every round-trip.

| measure | result |
|---|---|
| corpus files carrying a comment, DOCTYPE or PI | **1 / 22** (`C.3.0`) |
| of those, losing it on round-trip | **1 / 1** |
| parser warnings emitted about the loss | **0** |
| position of the lost construct | **header** (exporter banner, before the root element) |

**The finding that matters is not the loss — it is that ADR-001's stated guard could
not detect its own reversal condition.** ADR-001 says it reverses if "we find a file
where moddle silently drops content on round-trip", and names F2's profile as the
guard. F2 compares a *semantic tally of elements*. A comment was never an element, so
that comparison is structurally incapable of seeing this. The file was in the corpus
the whole time.

Incidence here is n=1 and cosmetic, which is why ADR-004 gains a warn-never-refuse
clause rather than a refusal: the naive text-editing baseline preserves comments for
free, so refusing would make the structured path strictly worse than the arm it has to
beat. Real-world incidence over public repositories is the deciding measurement and is
not yet taken.

**Standing consequence:** every ADR's reversal guard must be re-read for whether it can
actually detect the condition it claims to watch for.

## F11 — gate 5 could not see the damage the placement code causes

**2026-09-04 · `bench/probe/probe-labels.mjs`. Supersedes F9.**

Two independent blind spots line up exactly:

1. `boundsList()` (`gates.mjs:114`) is a lazy regex —
   `/<BPMNShape[^>]*bpmnElement="([^"]+)"[\s\S]*?<Bounds[^>]*x=…/` — so it captures the
   **first** `<Bounds>` after each shape's opening tag. In BPMN DI the shape's own
   `dc:Bounds` always precedes its `<bpmndi:BPMNLabel><dc:Bounds>`, so label bounds are
   never captured *by construction*.
2. The make-room loop (`place.mjs:107-110`) translates `di.bounds.x` and nothing else.

So when placement makes room, every affected external label stays where it was while
its shape slides out from under it — and gate 5 reports `rigid: true`.

Re-measuring F9's own four files off the moddle tree instead of the regex:

| file | shapes moved | distinct deltas | gate 5 said | labels detached |
|---|---|---|---|---|
| `handmade/zeebe-roundtrip` | 2 / 4 | 1 | rigid ✓ | 0 |
| `miwg/C.9.1` | 0 / 11 | 0 | rigid ✓ | 0 |
| `miwg/C.9.0` | 17 / 26 | 1 | rigid ✓ | **9** |
| `miwg/A.1.0` | 3 / 5 | 1 | rigid ✓ | **3** |

Twelve labels left behind across four files published as clean. Every detached element
is an event (`EndMessageEvent_Timeout`, `EndEvent_ApplicationIssued`, …), which is
consistent rather than coincidental: BPMN renders task labels inside the shape, so a
task has no separate `BPMNLabel` bounds to strand, while events and gateways carry
theirs outside.

**The general lesson is worth more than the bug.** F9 is the project's headline
preservation claim, and it was produced by an instrument structurally blind to the
failure mode it was built to detect — a regex reading serialized text, checking a
property of a tree. The fix is two lines. The process failure is that a gate and the
code it grades were written together, from the same mental model, by the same author.
Hence M1's oracle: the thing that guards a write is built separately from the thing
that scored the benchmark.

### Resolved 2026-09-04 (M1)

`translateShape(di, dx)` moves `di.bounds` and `di.label.bounds` together, and
`translateEdge` does the same for waypoints and edge labels. Re-measured:

| file | shapes moved | distinct deltas | labels detached |
|---|---|---|---|
| `handmade/zeebe-roundtrip` | 2 / 4 | 1 | **0** |
| `miwg/C.9.1` | 0 / 11 | 0 | **0** |
| `miwg/C.9.0` | 13 / 26 | 1 | **0** |
| `miwg/A.1.0` | 3 / 5 | 1 | **0** |

C.9.0 moved **13** shapes where it previously moved 17. That is the second half of the
fix, not a coincidence: the make-room loop used to run over the whole document with a
bare `di.bounds.x >= next.x` test, so inserting into one pool translated shapes in every
other pool and on every other plane that happened to sit to the right. It is now scoped
to the plane being drawn on and the container being edited, and pools and lanes are
never translated at all — their geometry derives from their contents, so a pool that
ends up too narrow needs resizing, which is a separate and still-open limitation.

**Gate 5 was not fixed and still cannot see labels.** That is deliberate. The gate is
the benchmark's scorer; `bench/probe/probe-labels.mjs` is what holds this property, and
it is in `npm test`. The write-guard that M3 needs is the oracle, built separately.

One correction to the probe itself. DI coordinates are doubles straight from the
exporter — A.1.0's labels sit at `x=395.3333333333333` — so an exact translation by
+151 reads back as `150.99999999999994`, and the first green run still reported one
detached label on A.1.0. That was the instrument, not the code. Deltas are now compared
rounded to 0.01px, far below anything a renderer can show. A probe that cries wolf costs
the same trust as one that misses the real thing.

## F12 — four defects in the arm-C prototype

**2026-09-04 · `bench/probe/probe-invariants.mjs`**

| # | defect | observed |
|---|---|---|
| D1 | `set {targetRef}` | the `set` fallthrough (`ir.mjs:232`) assigns any key verbatim, so an id **string** lands where moddle expects an element **reference** and serializes as `targetRef="undefined"` |
| D2 | `set {documentation}` | same fallthrough; `bpmn:Documentation` is a typed child collection, so a bare string throws `Cannot read properties of undefined (reading 'isGeneric')` on serialize |
| D3 | `del` orphans DI | deleting `Review` leaves 3 DI elements pointing at removed elements, and `diCoverage` reports **100% covered** because it only checks elements→DI, never DI→elements |
| D4 | `placeNew(container)` | `del` adds the **container** id to `changed` (`ir.mjs:260`), so the obvious `placeNew([...changed, ...created])` mints `<BPMNShape bpmnElement="Payment">` for the `bpmn:Process` itself |

D1 is the sharpest: F8 already states as a product invariant that "no code path may set
`sourceRef` or `targetRef` directly", and nothing enforced it. All five gates pass a
document containing `targetRef="undefined"`.

### Resolved 2026-09-04 (M1)

All four fixed; `bench/probe/probe-invariants.mjs` is now in `npm test`.

The common cause of D1 and D2 was one line — `else el[k] = v` — which wrote any key
verbatim onto the moddle object. `set` now takes a **closed allowlist**. Adjacency
fields (`sourceRef`, `targetRef`, `incoming`, `outgoing`, `attachedToRef`,
`flowNodeRef`) are refused by name with an explanation, which turns F8's stated
invariant into something enforced rather than merely written down. `id` is refused for
the same reason ADR-002 gives: the human has the file open in a modeller showing that
id. `documentation` is constructed as the typed child collection it is.

D3 is pruned in `applyPatch` rather than in the `del` branch, so the guarantee is
structural — no op, present or future, can leave orphaned DI. `diCoverage` now answers
both directions and returns `orphans` alongside `missing`.

D4 is fixed by filtering `placeNew`'s id list through the types it can actually place,
so passing it a container is a no-op instead of minting a shape for a `bpmn:Process`.

A note on testing D3. Once `applyPatch` prunes, the original probe could no longer
construct an orphan through it, and the assertion silently became a test of nothing.
It now removes the element behind moddle's back and leaves the shape on the plane,
because what is under test is the detector, not the op.

## F13 — the bpmn-js quarantine could be bypassed eight ways

**2026-09-04 · `scripts/licence-guard.mjs`**

ADR-009's guard was `for pkg in bpmn-js dmn-js form-js cmmn-js; do [ -d node_modules/$pkg ]`.

- **One false positive.** Unscoped `form-js` on npm is an unrelated MIT package. Any
  install of it failed the build for no reason.
- **Eight false negatives.** `@bpmn-io/form-js`, `-viewer`, `-editor`,
  `-carbon-styles` and `dmn-js-drd`, `-decision-table`, `-literal-expression`,
  `-shared` all carry the watermark clause and were never checked.

Verified: installing `@bpmn-io/form-js-viewer@1.26.0` passes the old check and fails
the new one twice over — its declared SPDX is `SEE LICENSE IN LICENSE`, and its
`LICENSE` text matches `/watermark/i`.

The ADR's stated rationale was also wrong. The bpmn.io licence names **no packages at
all**; it attaches the obligation to the watermark itself. So the guard now checks SPDX
ids and licence text across the installed production tree (21 packages, 1 dated
exception: `cli-table@0.3.11` ships MIT text with no `license` field).

## F14 — the v2 SDK serves both protocol eras from one factory

**2026-09-04 · `bench/probe/mcp-era/`, `npm run probe:mcp-era`**

ADR-010 targets `@modelcontextprotocol/server@2.0.0`, and kill criterion 2 says to fall
back to the v1 SDK if real clients cannot open a connection. The premise test: build a
minimal `serveStdio` server and drive it with a scripted opening in each era.

Verified first, independent of the probe: `@modelcontextprotocol/server@2.0.0` is MIT,
declares `engines: { node: ">=20" }`, and has exactly two runtime dependencies —
`zod@^4.2.0` and `@modelcontextprotocol/core@2.0.0`.

| opening | server response |
|---|---|
| 2025 era — `initialize` + `notifications/initialized`, then `tools/list` | answers `protocolVersion: "2025-06-18"` with `serverInfo`, then returns the tool |
| 2026-07-28 — no handshake, `protocolVersion` in `_meta`, `tools/list` | returns the tool, result carries `resultType: "complete"` |

**One factory, one tool registration, both eras, no branching.** The `ServeStdioOptions`
type documents this directly: `legacy?: 'serve' | 'reject'`, where the default `'serve'`
pins "a 2025-era instance from the same factory and serve[s] it exactly as a hand-wired
stdio server serves it today". The factory's context object carries an `era` key, so a
server that needs to branch can, and therblig does not.

Two incidental confirmations: every 2026-era result really does carry a required
`resultType`, and stdout stayed pure JSON-RPC in both runs while diagnostics went to
stderr — which is what M2's stdout-purity CI job exists to keep true.

**Consequence for kill criterion 2:** it is unlikely to fire on protocol grounds. The
SDK handles era negotiation itself, so the residual risk is only whether a given client
*launches* the binary correctly — a packaging and config question, not a protocol one,
and one that `npx -y therblig-mcp` addresses directly.

**Method note.** The probe's first two runs disagreed with each other: the 2025 arm
returned nothing, because the driver wrote its first message before the server had
finished resolving imports. It now blocks on a readiness line on stderr and is stable
across repeated runs. A flaky probe is worse than no probe — it produces a number that
is sometimes true.

## F15 — body-position comments occur in ~4% of public `.bpmn` files

**2026-09-04 · `bench/probe/probe-comment-incidence.mjs`, `bench/probe/comment-incidence.json`**

F10 measured that a moddle round-trip silently drops comments, but corpus incidence was
1 of 22 and the corpus is 21 vendor-written reference models. The policy question needs
files written by the people we are asking to trust us with theirs, so: 220 public `.bpmn`
files sampled across **161 repositories**, capped at 3 files per repository, over eight
diversified GitHub code-search queries.

| measure | files | share |
|---|---|---|
| carrying any comment | 15 | 6.8% |
| header / exporter banner only | 6 | 2.7% |
| **at least one body-position comment** | **9** | **4.1%** |
| carrying a DOCTYPE | 3 | 1.4% |
| carrying a non-declaration PI | 0 | 0.0% |

**4.1% is below the 5% threshold pre-registered in the plan, so kill criterion 1 does not
fire and ADR-004's warn-and-proceed clause stands as written.** No byte-level comment
splice is built.

**Two caveats that matter more than the headline.**

*What the comments are.* Most are structural dividers a generator emitted —
`<!-- Lanes -->`, `<!-- FLOWS -->`, `<!-- Lane Set: Departments / Functions -->`. Losing
one of those costs nothing. But not all: one file carries
`<!-- Process Variables: - tenantId: string - patientId: string - dischargeId: string … -->`,
which is real documentation, and the person who wrote it would not expect an editing tool
to delete it.

*The number is likely to rise.* A striking share of the body-comment hits are in
LLM-generated BPMN — `AutoBPMN`, `AI-Assistant`, a multi-agent review pipeline. Models
writing BPMN annotate it, because that is what models do with structured text. Files
authored by an agent are exactly the population an agent-facing editing tool will meet
most, so 4.1% is a floor on a moving quantity rather than a stable property of the format.

**Consequence:** proceed as planned, but re-run this probe before v0.1 and treat a
sustained move above 5% as the trigger for the header/footer splice. The measurement is
cheap and the file it writes is committed, so the comparison is a single command.

**Method note.** The probe's first run fetched zero files — Windows `cmd.exe` mangled the
`--jq` expression — and printed `body-comment incidence 0.0% -> WARN AND PROCEED`. It
produced the same policy conclusion this one did, from no evidence at all. It now refuses
to emit a verdict below a 100-file sample. That is the same failure as F11 in a different
costume: an instrument reporting success because it measured nothing.

## F16 — the corpus could not catch a false refusal on an ordinary file

**2026-09-06 · `bench/corpus/handmade/collapsed-subprocess.bpmn`, `packages/therblig/src/place.mjs`**

A collapsed sub-process renders as a single box. Its children are deliberately absent
from the plane, because nothing draws them. `diCoverage` demanded a shape for every
element regardless, so a perfectly ordinary file reported:

```
ok: false | need 10 covered 5
missing: Pack_Start, Pack_Pick, Pack_End, Pack_Flow_1, Pack_Flow_2
```

Since DI coverage gates the write barrier, that is not a cosmetic complaint — it would
have **refused every edit to any file containing a collapsed sub-process with children**,
which is a large share of real Camunda models.

**Nothing in the corpus could find this.** All six collapsed sub-processes across the 21
MIWG reference models have zero children, so the check passed on every file available
and would have kept passing until a design partner hit it. The fixture was hand-authored
to expose it, and the fix — skip the subtree of any sub-process whose shape carries
`isExpanded="false"` — is four lines.

The general point, which now has three instances in this project: **a corpus is a sample,
and a gate calibrated only against a sample is calibrated against that sample's
accidents.** F11 was an instrument blind to the damage it graded; F15's first run drew a
policy conclusion from an empty sample; this is a check that could only ever pass. The
response in each case is the same — write the fixture that can fail before trusting the
result that passes.

## F17 — the write barrier refused three ordinary edits, and only real files showed it

**2026-09-06 · `bench/corpus-sweep.mjs`**

The sweep applies whichever of six canonical edits each file can express — insert,
rename, boundary event, condition split, sub-process-scoped insert, delete — and holds
every result to the same invariants: parses, XSD-valid, no newly introduced error, DI
coverage both directions, `distinctDeltas <= 1`, zero detached labels, and a receipt
that re-derives from the two versions.

First run: **105 of 124 edits passed.** Every one of the 19 failures was the barrier
refusing a correct edit, in three classes, none of which the hand-written fixtures had
reached:

| class | files | what the guard called unintended |
|---|---|---|
| undrawn process | B.1.0, B.2.0 | five elements of a process referenced by a call activity that no plane draws — it needs no DI, and `diCoverage` demanded it anyway |
| element children | 7 files | `bpmn:Documentation` and `bpmn:PotentialOwner` inside a deleted task |
| incident children | 3 files | a `bpmn:TimerEventDefinition` inside a boundary event that was itself only in scope because it was attached to the deleted task |

All three are the same mistake in different clothes: **the expected set was not
transitive.** Naming an element puts what is inside it in scope, and so does being
pulled in by attachment. After the fix, **124 of 124**, worst `distinctDeltas` 1, labels
detached 0, orphaned DI 0.

The undrawn-process case is the one to keep in mind. It is F16 exactly — a rule that is
right for the shape of file the corpus mostly contains and wrong for a shape it contains
twice — and `inspect` had already been taught about it while `diCoverage` had not, so
the same fact had to be learned in two places. The lint was correct and the barrier that
gates writing was not, which is the worse way round.

**None of this was reachable from the fixtures.** The guard passed every hand-written
test both before and after, because the hand-written tests use files whose elements have
no documentation, no performers and no undrawn siblings. A sweep over nine exporters'
output found all three in one run.


# Studio findings

The following evidence was recorded on the Studio branch before reconciliation.
Keep its results and limitations together; these numbers are not fresh merge results.

## Studio F10 — nothing in the toolchain checks a BPMN reference, and the corpus is 21/22 clean

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

## Studio F11 — deleting an element must delete what it contains, and the reference gate proves it

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

## Studio F12 — a fork makes room, it does not reflow

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

## Studio F13 — an op that adds an element must label it, or the model gets worse

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

The one style delta the ops do not fix is `no-implicit-split` on a message flow's source (Studio F11),
which is bpmnlint counting something BPMN does not branch on.

## Studio F14 — four harness defects, found by spending $6 before claiming anything

The bench was run against the real API on 2026-09-06. The first three cells would have printed
`raw 1/1, raw_ir 1/1, treadle 0/1`. **That scoreboard was false**, and so were the two after it.
Four defects had to be closed before a single cell measured what it claimed to.

| # | defect | how it showed | fix |
|---|---|---|---|
| 1 | the structured arm received no tools | `mcp_servers: connected`, zero `mcp__treadle__*` in context; the agent spent its session calling `ToolSearch` for `Read` and `Edit` | see below |
| 2 | a rejected schema drops a whole server | `z.record(z.string(), z.unknown())` renders as `propertyNames` + `additionalProperties`, which the CLI rejects — silently, and for **every** tool on that server | `z.looseObject({})` |
| 3 | tool search deferred what was left | 16 tools sat behind `ToolSearch` instead of being in the turn-one prompt | `ENABLE_TOOL_SEARCH=false` |
| 4 | **the arms were not isolated** | arm A called `mcp__treadle__open`. `allowedTools` auto-approves rather than restricts, and naming a tool in `disallowedTools` did not remove it either | each arm gets only the server it should have; `only` filters the tool list |

Defect 1 was diagnosed wrongly at first: three documented `alwaysLoad` paths were tried and blamed
before defect 2 turned out to be the cause. The record is kept as it happened — `alwaysLoad` on
`createSdkMcpServer` genuinely is not propagated onto the config it returns, but that was not why
the tools were missing.

**A correction.** An earlier version of this finding claimed the developer's machine leaked into
every cell, citing 16 skills, 48 slash commands and 5 agents in the `init` message. That was wrong:
`plugins: []` in the same message shows `settingSources: []` did its job, and the skills and slash
commands are the CLI's own — identical for anyone running this. The claim is withdrawn.

Defect 4 is the one that would have poisoned everything. Two arms sharing a tool surface is not a
comparison, and nothing in the scoreboard would have shown it; only the recorded transcript did.

### What the harness now refuses to do

A cell that used none of its own arm's tools is scored `HARNESS`, not as a product failure —
that guard is what caught defect 1 instead of turning it into a finding about the product.

### Calibration, not a result

One cell (T04, one run per arm) after all four fixes:

| arm | what it called | turns | cost |
|---|---|---|---|
| `raw` | `Read → Edit ×5 → Grep` | 8 | $0.54 |
| `raw_ir` | `open → project → Read → Edit ×5 → lint` | 11 | $0.75 |
| `treadle` | `open → project → bypass → publish → lint` | 6 | $0.34 |

All three produced a correct edit. **These numbers are a budget calibration and nothing else.**
N=1 on one task in one category; the same cell has cost $0.24 and $0.80 across runs on identical
inputs. The 20 × 3 × 3 design exists because a single cell cannot distinguish a result from
variance, and no percentage may be quoted from this table.

## Studio F15 — the first valid bench cell found two defects in the shipped MCP server

Neither was visible from the test suite, and both came out of one transcript.

**The model had to guess argument names.** Every op declared `args: { type: 'object' }`, so nothing
told an agent what went inside. The transcript shows `bypass` called three times in a row with
`{target}`, then `{node}`, then `{id}`. The design document that specified this server had already
warned against it — *"uma ferramenta genérica `apply(op, args)` joga essa acurácia fora"* — and the
implementation did it anyway. Every op now declares its real arguments, with `additionalProperties:
false`.

**The idempotency cache was keyed by `patch_id` alone.** The agent reused one id across its retries
and then on `publish`, which found the `bypass` result under that key and returned it as its own:
nothing was written, and the agent reported success. A `patch_id` is the caller's, and a caller
reuses one; the tool is part of the identity of a call, so the key is now `tool:patch_id`.

Both are covered by smoke tests that spawn the real stdio server. Reproduce:

```sh
node --test backend/test/smoke/mcp.test.mjs
```

## Studio F16 — three candidate semantic rules, and only one of them is ours to write

The plan scoped a graph-global `check` module from whatever the bake-off revealed. The bake-off
has not run, so the scope came from the same discipline Studio F10 used instead: propose a rule, build the
document it should catch, and check whether anything already catches it.

| candidate | XSD | `bpmnlint:correctness` | `bpmnlint:recommended` | verdict |
|---|---|---|---|---|
| a node unreachable from any start | passes | passes | **`no-disconnected`** | not ours |
| a node that reaches no end | passes | **catches** | — | not ours |
| an event gateway whose target cannot wait | passes | passes | passes | **ours** |

An event-based gateway is a race, and every path out of it must begin with something that can
wait — a catch event or a receive task. A plain task on one of those paths wins the race the
instant the gateway is reached, so the gateway decides nothing. Nothing in the toolchain says so.

That is the whole of the `semantics` gate: **one rule**, because one rule is what the evidence
supports. Two of the three candidates would have been duplicated work, and `explain` already
reports reachability as a reading rather than as a gate, which is where it belongs when bpmnlint
gates it.

The 22 MIWG models are clean under this rule, so it is a hard gate with a differential wrapper in
`scoreAll` — the same bargain as `references` and `bpmnlint:recommended`.

Reproduce:

```sh
node --test backend/test/unit/semantics.test.mjs
```

## Studio F17 — the corpus can be simulated, and what stops it is a missing scenario, not a missing feature

`simulate()` runs the 21 MIWG models and the two handmade fixtures. Every run either produces a
cycle time or says exactly what it could not do.

| outcome | files | what it means |
|---|---|---|
| ran | 16 | reached an end on every run |
| **undecided** | 2 (`C.1.0`, `C.1.1`) | a gateway the caller gave nothing to decide with |
| **unbounded** | 2 (`C.2.0`, `C.7.0`) | a rework loop the scenario never exits |
| **unsupported** | 1 (`B.2.0`) | an inclusive join, refused by name |

Only one of the four stopping conditions is a limit of the machine. The other three are questions
for whoever is asking, and answering them makes the model run:

```
C.7.0, no scenario           → p50 null, undecided: 1 gateway
C.7.0, { Yes: 0.8, No: 0.2 } → p50 5h, p90 7h
```

That difference is the finding. `C.7.0` sends an unapproved advertisement back to be approved
again, and the 7-hour p90 against a 5-hour p50 is the rework showing up in the tail — which is the
only reason to simulate a process at all.

### Two things the corpus taught the design

**A real gateway carries a label, not an expression.** Every exclusive gateway in the corpus
documents its decision with a flow name — `Yes`, `No`, `covered` — and not one carries a formal
condition. A scenario keyed only by condition text would have addressed nothing, so `when` accepts
a flow's condition, its id, or its label.

**Weights on one gateway are a distribution.** Sampling each exit independently made
`{ Yes: 0.8, No: 0.2 }` fall through 16% of the time and report the gateway undecided — a scenario
the caller had every reason to think was complete. Naming one path at `0.25` now leaves `0.75` to
be shared by the rest.

### What it refuses

`p50` is `null` whenever anything was refused, undecided, deadlocked or unbounded. A number
alongside a warning gets quoted without the warning.

An inclusive join, a complex gateway, compensation and multi-instance are refused by name: each
needs information no node carries on its own. A subprocess and a call activity run as one opaque
step, which is stated rather than hidden. And `synthetic: true` says out loud when no duration in
the file was annotated, because a p50 to the hour on invented input is opinion with decimal places.

Reproduce:

```sh
node --test backend/test/unit/simulate.test.mjs
```
