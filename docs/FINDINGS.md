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

**2026-09-01 · `bench/arms/ir.mjs`, found by `place-selftest.mjs`**

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
