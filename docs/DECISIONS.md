# Architecture decisions

Short records. Each states the decision, what it rests on, and what would reverse it.
Findings live in [FINDINGS.md](FINDINGS.md).

## Record scope after the Studio merge

The unqualified ADR-001–ADR-012 records below come from `origin/main` at `7722884`.
The Studio branch at `eee02c3` independently assigned ADR-010–ADR-030. Its distinct
records are preserved below as **Studio ADR-010–Studio ADR-030**, with references in
that section qualified to keep the two histories unambiguous. Dated plans elsewhere
retain their original numbering; read references in those plans in their branch context.

The merged repository is named **therblig** and is not published to npm. It retains
both callers: the path-addressed `therblig` CLI/MCP and the governed `treadle` CLI/MCP
used by the Studio branch. ADR-010 rev. 2 describes the path-addressed server; Studio
ADR-023 describes the governed server. Neither record removes the other caller. Both
share `backend/core`, including the added `move` and `message` primitives, while the
Studio keeps its intent operations, simulation, review, conformance and renderer.

`bpmnlint` remains a runtime dependency: the public core exports and both CLI callers
use it for validation. The Studio branch's attempt to remove it from the production
tree is superseded by those concrete callers. `bpmn-auto-layout` remains a bench
dependency, subject to ADR-005's recorded licence limitation. The local frontend is
private and does not enter the published tarball.

The oracle and the benchmark scorer have different responsibilities. A historical
record describing one is not evidence that it guards the other. Likewise, recorded
coverage, corpus totals and preservation measurements describe the revision and
instrument that produced them; they must be rerun before being claimed for this merge.

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

**Amended 2026-09-04 (F10).** Known loss: XML comments, DOCTYPE declarations and every
processing instruction other than the XML declaration are dropped on every round-trip,
silently, with zero parser warnings — `moddle-xml` registers no saxen handler for
`comment` or `attention`. Measured incidence: 1 of 22 corpus files (`C.3.0`), in header
position.

This **bounds** the decision rather than reversing it. moddle remains the only structure
that preserves unmodelled vendor namespaces, which is the property F1 tested and the one
that actually matters. therblig warns; it does not refuse. New guard:
`bench/probe/probe-conserve.mjs`.

The important part is not the loss. **This ADR's stated reversal guard could not detect
its own reversal condition**: the condition is "moddle silently drops content on
round-trip", and the named guard is F2's profile, which compares a semantic tally of
*elements*. A comment was never an element. The file was in the corpus from the start.

**Standing rule, adopted from this:** every ADR's reversal guard must be re-read for
whether it is capable of observing the condition it claims to watch.

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

**Amended 2026-09-04.** The decision stands; the evidence needs version scoping. F4 is a
measurement of `bpmn-auto-layout@2.0.0-alpha.2` (published 2026-07-24), still the newest
published build as of today. Every public citation of F4 must name that version.

The load-bearing half is version-independent and is what the wedge actually rests on:
the `warnings` channel does not signal loss. That is a property of the package's error
contract, not of which constructs it supports in a given month.

## ADR-004 — Normalization is Prettier's bargain, stated up front

First edit reformats the file. Every edit after that is minimal.

**Rests on:** F2 (1/22 byte-identical, but 22/22 idempotent) and F3 (Camunda-authored
files cost −1 +2 lines to normalize; others get a full reformat).

Told to the user honestly rather than papered over: a `therblig fmt` command makes the
one-time diff a separate, reviewable commit instead of hiding it inside their first edit.

**Reverses if:** design partners reject the reformat. The fallback is a surgical XML
splicer that edits bytes in place — exact, but substantially harder.

**Amended 2026-09-04 (F10).** The bargain has a second clause, and it must be stated as
plainly as the first: **the first `therblig fmt` also deletes XML comments, DOCTYPE
declarations and processing instructions.**

`therblig fmt --check` and `therblig lint` warn before any write when the input carries
such constructs. therblig never refuses on this basis — the naive text-editing baseline
preserves comments trivially and for free, so a hard refusal would make the structured
path strictly worse than the arm it has to beat, on a real axis.

**Reverses if:** `moddle-xml` registers a comment handler upstream, or measured
real-world incidence rises above 5%.

**Measured 2026-09-04 (F15).** 220 public `.bpmn` files across 161 repositories:
**4.1% carry a body-position comment**, 2.7% carry only an exporter banner, 1.4% carry a
DOCTYPE, none carry a non-declaration PI. Below the 5% threshold, so this clause stands
and no byte-splice is built. Two caveats are on the record in F15: most body comments are
generator-emitted section dividers, but not all — and the hits cluster in LLM-generated
BPMN, which is the population an agent-facing tool will meet most. Re-run
`npm run probe:comment-incidence` before v0.1; a sustained reading above 5% triggers the
header/footer splice.

## ADR-005 — DI coverage is a hard CI gate; the layouter's warnings channel is not trusted

Every layout call is followed by our own check that every element needing a shape or edge
got one. Build fails below 100%.

**Rests on:** F4 — `C.4.0` lost 52 of 107 elements and emitted zero warnings.

`bpmn-auto-layout@2.0.0-alpha.2` is pinned exactly and vendored. It is an unreleased alpha
under a `next` dist-tag from a package that ships no LICENSE file (MIT is declared in
`package.json` and README only). This is the single largest supply-chain exposure in the
project and is recorded as such, not as a footnote.

**Amended 2026-09-04. Two factual corrections and one scope change.**

**(a) "pinned exactly and vendored" was false.** `third_party/` contains only `omg/`.
`bpmn-auto-layout` is an ordinary npm dependency and always has been.

**(b) "a package that ships no LICENSE file" understates it.** No published version has
ever shipped one — stable 1.3.0 included. So downgrading off the alpha is *not* a
mitigation for the licensing exposure, which the original wording implies. The only
grant is the string `"license": "MIT"` in `package.json`; there is no copyright notice
to reproduce.

**(c) Scope change: `bpmn-auto-layout` is not a runtime dependency of anything
published.** F9/F11 show incremental placement covers every edit to a file that already
has DI, which is the entire edit-first product; full-file layout is needed only to
construct the baseline arm. It stays pinned exactly as a bench devDependency and as an
optional peer of `therblig`, dynamically imported only by `therblig layout --experimental`,
whose `--help` prints F4's version-scoped failure rate. Honestly stated: this removes it
from the published dependency surface but **not** from the lockfile, and procurement
tools that read lockfiles will still see it.

A file with no `BPMNPlane` is refused with `TRD_NO_DI` and a coverage-check recipe —
never with a pointer to `npx bpmn-auto-layout`, which is the exact CLI F4 measured
silently dropping half a reference model.

**Merge clarification 2026-09-07.** The optional-peer / `layout --experimental`
paragraph above records a proposed distribution path, not an implemented command in
either retained CLI. Do not advertise it as available. The bench dependency remains
pinned, and the merged package’s production dependency audit must verify its exclusion.
The Studio branch independently moved the layouter to development-only use for the
same reason: incremental placement does not call it.

## ADR-006 — `bpmnlint:correctness` is a hard gate; `recommended` is differential

**Rests on:** F5 — the OMG reference models pass `correctness` 22/22 and `recommended`
9/22. Scoring anything against absolute `recommended` cleanliness penalises it for the
input file's pre-existing style violations.

**Amended 2026-09-04. The mechanism was wrong, not the principle.** The differential is
implemented at `gates.mjs:169` as `styleAfter.errors.length - styleBefore.errors.length`
— a **count** subtraction. Since 13 of 22 corpus files already fail `recommended`, an
edit that incidentally clears one pre-existing style error while introducing a
`no-disconnected` scores 0 and passes.

That is worse than it sounds. `no-disconnected` exists only in `recommended`;
`correctness` is 8 rules and contains no such rule; the XSD makes the node side of
adjacency optional (which is exactly what F8 measured); and `fingerprint()` never reads
`incoming`/`outgoing`. **So this count subtraction is the only thing in the entire
five-gate scorer standing between a model and a violation of F8's dual-adjacency
invariant.**

The differential now compares multisets of `${rule}:${elementId}` identities. Any newly
introduced rule instance fails the gate regardless of what else the edit happened to
fix. Dual adjacency is additionally asserted structurally in the M1 oracle rather than
inferred from a lint differential — a differential over a noisy baseline is not a safety
property.

## ADR-007 — Node 22.12 floor

**Rests on:** F6 — `bpmnlint@11.13.0` CJS-requires an ESM-only `min-dash@5`, which only
works where `require(esm)` is enabled. Not caused by the layouter, which runs fine on 20.

**Amended 2026-09-04. Right number, wrong reason — and it is a choice, not a
constraint.** Re-measured: on Node 20.10 `import('bpmnlint/lib/linter.js')` throws
`ERR_REQUIRE_ESM` on `min-dash/dist/index.js`, and `import('bpmn-auto-layout')` resolves
cleanly. So F6's attribution — the floor comes from bpmnlint, not the layouter — is
correct.

But `bpmnlint@11.13.0` declares `engines: { node: ">= 20" }`, and Node unflagged
`require(esm)` in **20.19.0**. The floor this dependency chain strictly forces is
therefore 20.19. **22.12 is a chosen floor** — where `require(esm)` is unflagged on the
22 LTS line — and is stated as a choice.

A claim considered and rejected on the evidence: that `bpmn-auto-layout` 2.x forces
22.12. The installed `2.0.0-alpha.2` declares `engines: { node: ">= 18" }` and imports
successfully on 20.10.

**A second, higher DEV floor applies.** `@modelcontextprotocol/inspector` declares
`node >= 22.19`, so a contributor provisioning from `.nvmrc` must land above that or CI
fails on a machine that satisfies this ADR. `.nvmrc` and `.node-version` therefore pin
22.20.0 (the version these findings were re-measured on) while `engines` keeps the
consumer floor at `>=22.12`.

**Enforced, not declared.** `.npmrc` sets `engine-strict=true`, and CI has an
`engine-floor` job that asserts `npm ci` *fails* on Node 20. This is not hypothetical
hygiene: the machine that produced F1–F9 was running Node 20.10 against a declared
`>=22.12` floor with no `.npmrc`, and `.node22path` pointed into a deleted scratchpad.

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

**Amended 2026-09-04 (F13). The rationale was false and the guard was broken in both
directions.**

The bpmn.io licence **names no packages at all.** It grants MIT-like terms "except that
the source code responsible for displaying the bpmn.io project watermark ... MUST NOT be
removed or changed". The obligation travels with the watermark, not with four names.

The guard was `for pkg in bpmn-js dmn-js form-js cmmn-js; do [ -d node_modules/$pkg ]`:

- **one false positive** — unscoped `form-js` on npm is an unrelated MIT package, so any
  install of it failed the build for no reason;
- **eight false negatives** — `@bpmn-io/form-js{,-viewer,-editor,-carbon-styles}` and
  `dmn-js-{drd,decision-table,literal-expression,shared}` all carry the clause and were
  never checked.

Replaced by `scripts/licence-guard.mjs` over the installed **production** tree:
(a) every package must resolve to an SPDX expression on an allowlist — `SEE LICENSE IN
LICENSE` fails generically, which future-proofs against packages bpmn.io has not
published yet, and disjunctions like `(MPL-2.0 OR Apache-2.0)` are satisfied by one
allowed term; (b) every shipped licence text is grepped for `/watermark/i`; (c) a dated
exception table, currently one entry (`cli-table@0.3.11`, no `license` field, ships
verbatim MIT text).

`bpmn-js-differ` is **explicitly permitted** — verified MIT, no watermark, no `bpmn-js`
dependency, and it already separates `_layoutChanged` from `_added`/`_removed`/`_changed`,
which is exactly the split the M4 preservation receipt needs.
`@anthropic-ai/claude-agent-sdk` is **explicitly denied**: its licence is
"(c) Anthropic PBC. All rights reserved", strictly more restrictive than the clause this
guard exists to exclude, and therblig never needs it because the product *is* an MCP
server.

**A guard never seen to fail is not known to work.** CI installs
`@bpmn-io/form-js-viewer` and asserts the guard rejects it. Verified 2026-09-04: it
fails twice over, on SPDX and on licence text.

## ADR-010 (rev. 2) — Stateless, path-addressed MCP; no handles, no `patch_id`

*Rev. 1 (2026-09-01) proposed server-minted handles with `base_rev` and `patch_id`.
Three of its five premises were refuted on live verification 2026-09-04 and its
idempotency mechanism had no basis in the spec. Superseded in full.*

**Decision.** therblig's MCP tools take an absolute file path as an ordinary tool
argument, and the server holds no cross-call state. Consistency is carried by
`base_rev` — the first 12 hex characters of the SHA-256 of the raw file bytes —
returned by every read and **required** by every write that is not a dry run.

**Rests on (verified 2026-09-04).** MCP revision 2026-07-28 is current and is stateless
by design. It removed protocol-level sessions and the `Mcp-Session-Id` header
(SEP-2567), removed the `initialize`/`notifications/initialized` handshake, and removed
SSE resumability (SEP-2575).

**What rev. 1 got wrong.**

- *"Sampling was removed."* It was **deprecated**, not removed — alongside Roots and
  Logging (SEP-2577) — and remains fully functional, earliest removal being the first
  revision on or after 2027-07-28. Conveniently, the published migration paths are
  already what we do: pass files as tool parameters instead of Roots, log to stderr
  instead of Logging.
- *Treating "Stateful Tools" as normative.* That section is explicitly non-normative:
  "The protocol has no concept of a state handle; from the wire's perspective a handle
  is an ordinary string in a tool result and an ordinary argument to subsequent tool
  calls."
- *"The frozen v1 SDK."* v1 is maintenance-only, not frozen —
  `@modelcontextprotocol/sdk@1.30.0` is current and supported for at least six months
  past v2.

**The handle pattern is declined.** The spec's worked examples are a shopping cart, an
open browser context and a database transaction — all ephemeral *server-side* state.
therblig's state is a file the filesystem already names. A handle would buy latency and
would turn every recovery path — stale rev, server restart, an external save from
Camunda Modeler — into a failure mode rather than a re-read.

**`patch_id` is dropped.** The 2026-07-28 core spec contains no idempotency mechanism,
no request-dedup rule and no retry-safety requirement; the only artifact is
`ToolAnnotations.idempotentHint`, which the schema itself calls a hint clients must
treat as untrusted. Any key would have been a therblig-level invention, and a required
`base_rev` is strictly stronger: it survives a restart, needs no store, and detects an
external write that a counter could not. Residual TOCTOU between hash and rename is
real and stated — `base_rev` is advisory against a concurrent Modeler save, not a lock;
the atomic rename guarantees only that the file is never observed truncated.

**Build target.** `@modelcontextprotocol/server@2.0.0`, pinned exactly. Verified today:
MIT, engines `>=20`, and exactly two runtime dependencies (`zod@^4.2.0` and
`@modelcontextprotocol/core@2.0.0`). Not v1 — not because v1 is dead, but because its
tree drags express, hono, cors, jose, ajv and eventsource into what is a stdio-only
offline binary. stdio only: no Streamable HTTP, so no `server/discover` header
machinery, no 405-on-GET, no cache-TTL obligations.

`tools/list` is a fixed, deterministically ordered static set that never varies per
connection or per open file — which SEP-2567 now requires and which the path-addressed
design satisfies by construction.

Adopted from the non-normative checklist anyway: every staleness or not-found condition
returns a tool **execution** error (`isError: true`) with actionable recovery text,
never a JSON-RPC protocol error.

**Reverses if:** a host sandbox prevents reading a path the user named. Guard: `--root`
confinement ships in v0.1, and any such report is the trigger to add an `open`/handle
pair after all.

**Open:** whether `serveStdio`'s default legacy mode connects on Claude Code, Claude
Desktop, Cursor and VS Code. Measured in M0; kill criterion 2 drops to
`@modelcontextprotocol/sdk@1.30.0` for the transport only if two or more fail. Nothing
above depends on that outcome — it rests on the spec's statelessness, not on the SDK.


## ADR-011 — `move` and `message` are their own operations, not flags

**2026-09-06.** The four ops were "deliberately four: add, set, del, connect", and the
first instinct on needing lane moves and message flows was to add a `lane` key to `set`
and a `--message` flag to `connect`. Both were wrong, for the same structural reason.

**Lane membership is not a property of the node.** It is a list of `flowNodeRef` on the
`bpmn:Lane`. There is nothing on the node to set, which is why `set {patch:{lane}}` fell
through the old open assignment and wrote a junk property that serialized silently
(F12/D1's sibling). Moving is two edits — one lane loses the reference, another gains it
— and doing half leaves the node listed twice or not at all.

**A message flow is not a sequence flow with a flag.** It has a different parent (the
`bpmn:Collaboration`, not either process), lives in a different collection
(`messageFlows`), and takes no part in node adjacency, because `<incoming>`/`<outgoing>`
hold sequence flows only. Three differences, none of which a boolean expresses.

Both would have been expressible as options, and both would have hidden a structural
difference behind a parameter — which is the shape of every bug in F12.

**Rests on:** the corpus sweep, which now runs eight canonical edit kinds over 23 files
(139/139). `move` reaches 9 files and `message` 6; the per-kind counts are printed so a
category silently reaching zero files is visible rather than assumed.

**Reverses if:** a third construct turns out to need the same treatment and the op list
starts to read as a catalogue rather than a vocabulary. The line to hold is that an
operation exists when the underlying structure differs, not when the user's phrasing does.

## ADR-012 — `backend/core` is the structure; the second extraction was reconciled onto it

**2026-09-06.** Two efforts extracted the same core from commit `a9ab476`, three days
apart, without knowing about each other. PR #1 (Nicollas Isaac, merged 2026-09-03)
promoted it to `backend/core/` with documented module boundaries and a 100%-coverage
gate. The parallel line of work extracted it to `packages/therblig/src/` on the way to a
CLI, an MCP server, an oracle and a write barrier.

**Theirs is the structure that survives.** It was merged first, and it is the one with
its rules written down — `CLAUDE.md` states the module boundaries, forbids a generic
`src/`, and requires a reproducer for every claim. Deciding by whoever pushes second is
not a decision.

Adopted from it: the layout, the module names, `node --test` with 100% line, function and
branch coverage on the core, oxlint with `--deny-warnings`, and — most usefully —
`adjacency.mjs` as the only module permitted to assign `sourceRef`, `targetRef`,
`incoming` or `outgoing`, enforced by an architecture test. That is a stronger guarantee
than the runtime allowlist in the other line, because it holds for code nobody has
written yet. Both are kept: the test constrains core modules, the allowlist constrains a
caller's operations, and neither sees what the other does.

Ported onto it, because `backend/core` forked from the same pre-M1 code and carried every
defect M1 had already found: labels not travelling with their shapes (F11), an unscoped
make-room shift, one-directional DI coverage with no exemption for collapsed
sub-processes or undrawn processes (F16, F17), and the open `set` fallthrough (F12).
Then the layers that had no counterpart — oracle, guard, write barrier, receipt,
renderer, CLI, MCP server — as siblings of `core/` rather than inside it, since core is
defined as having no I/O.

The sweep found two more while reconciling: `insertionFor` read `container.flowElements`
before it existed and threw on a real file, and the guard's expected set was not
transitive through attachment, so deleting a task reported the flow of its own boundary
event as an unintended change.

**Resolved 2026-09-06.** The repository was renamed to `EduardoHOS/therblig` by its
owner, and `CLAUDE.md`, the package metadata and the remote now follow. The dated design
note under `docs/superpowers/specs/` keeps the old name, because it records what was
decided on 2026-09-03 and rewriting it would make the record less true rather than more.
Nicollas has been working under the previous name and should be told rather than left to
discover it from a diff.


# Studio decision records

These records preserve the Studio branch's design and evidence at `eee02c3`.
Package names and implementation status inside them are historical. References to
Studio F10–F17 resolve to the Studio findings section of [FINDINGS.md](FINDINGS.md).
The original Studio ADR-010 protocol rationale is historical: the corrections in
ADR-010 rev. 2 above apply to its statements about MCP, sampling and SDK support.
Retaining a governed caller does not reinstate those refuted protocol claims.

## Studio ADR-010 — Stateless MCP with server-minted handles

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

## Studio ADR-011 — Ops compile intent to primitives; nothing above `patch.mjs` touches the tree

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

## Studio ADR-012 — One block, one definition; a slot exists only where blocks differ

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

## Studio ADR-013 — Gates live in the core; the bench re-exports them

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
also the reason a passing XSD gate says nothing about reference integrity, which is Studio ADR-014's job.
`fingerprint` now walks with `document.mjs`'s `walk` instead of its own copy.

## Studio ADR-014 — A proposal is a dry run against an isolated document

`propose(document, plan)` serializes and re-parses the caller's document (there is no deep clone
of a moddle tree, so a round-trip is the clone), applies the plan to that copy, places what it
created, scores every gate, and returns `{ ok, xml, gates, diff, created, changed, placed }`.
The caller's document is never mutated, so a plan that fails halfway leaves nothing behind, and
the error names which operation of how many failed.

**Rests on:** the guard test — a two-operation plan whose second operation is invalid leaves the
source byte-identical. Removing the isolation fails it.

**No `rev` yet.** The design pairs proposals with a revision handle, but no store exists: that
arrives with the MCP server, and a handle with no store to key would be a speculative field.

## Studio ADR-015 — Reference integrity is its own gate, and it is differential

`references(xml)` resolves every BPMN reference and checks scope: a sequence flow may not cross a
container, a boundary event may not attach across one, a lane may not claim a node from another
process, and a default flow must leave the element that names it. Only a message flow may cross.

**Rests on:** Studio F10 — seven broken documents, each XSD-valid and `bpmnlint:correctness`-clean, and
none of them caught by anything else. This is the measured form of the invariant that XSD validity
must never be reported as complete reference integrity.

**Differential inside `scoreAll`, absolute on its own.** `miwg/C.7.0` ships a `BPMNEdge` with no
`bpmnElement`, which BPMNDI permits; blocking every edit to that file would repeat the mistake
ADR-006 already names. A proposal fails on what it broke, not on what it inherited.

**Not rules here:** duplicate ids (the XSD's `ID` type catches them) and `calledElement` (a call
activity may legitimately name a process in another file — a workspace concern, not a file one).

**Reverses if:** a corpus file trips a scope rule that BPMN actually permits. The gate is then too
strict and the rule, not the file, is wrong.

## Studio ADR-016 — A connection's kind is decided by scope, not by the caller

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

## Studio ADR-017 — An op guarantees an exact inverse; a primitive does not

`bypass` refuses a node carrying boundary events instead of cascading them, because the IR does
not carry a timer's duration or an error code and the re-added boundary could not be restored.
An inverse that silently drops data is worse than a refusal that names the remedy: remove the
boundary first, or use `del` and accept the loss.

**Rests on:** the envelope promises `inverse`, and every op test applies plan then inverse and
compares the semantic fingerprint. A lossy inverse would pass that check while losing content.

**`risk` counts `lane` as routing.** Moving a step between lanes moves no token, but it changes
who executes the work — not something an autonomous agent should do unreviewed.

## Studio ADR-018 — A fork mints its split and join as a pair

`branch` and `parallel` create both gateways in one plan and return `{ split, join }`, so an
unbalanced gateway stops being expressible at this height. The first branch consumes the direct
split-to-join flow that `add … between` leaves behind, which is why that flow is always the one a
default can name; every later branch is connected explicitly.

**Rests on:** Studio F12 — 18 of 18 file/op combinations move their shapes by a single delta, so the
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

## Studio ADR-019 — `backend/io` is the only filesystem boundary, and it confines by real path

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

## Studio ADR-020 — The CLI reads before it writes, and confines to the working directory

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

## Studio ADR-021 — Dry run by default; `--write` publishes, `--allow` decides how far

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

## Studio ADR-022 — TypeScript contracts are emitted from JSDoc, never hand-written

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

## Studio ADR-023 — The MCP server proposes freely and publishes under a policy

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

## Studio ADR-024 — A semantic rule ships only with proof that nothing else catches it

The `semantics` gate holds one rule. Two other candidates were built, measured, and dropped
because `bpmnlint` already catches them (Studio F16). A gate that repeats another gate costs the same to
run and teaches a reader that a finding is our own when it is not.

The test for each rule constructs the document it should catch and asserts XSD validity and both
bpmnlint presets pass it *before* asserting this gate does not — so a rule that stops being ours,
because a linter grew it, fails the suite rather than quietly duplicating.

**No `check` slot on the block table.** One rule on one block would be a slot with a single
implementation, which Studio ADR-012 rules out. The rule lives in the module that consumes it, and moves
to the table when a second block needs one.

## Studio ADR-025 — Discrete-event tokens, and a refusal wherever the model needs more than a node knows

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

## Studio ADR-026 — The review packet is the deliverable; the diagram is not

`review(before, after)` produces what a reviewer reads: what was added, removed, renamed,
rerouted, retyped and reowned — **by id**, because ids survive an edit, so a rename is a rename
rather than a removal and an addition. Then the gates, the diagram delta, and the cycle time.

**It is silent about cost when it does not know.** No annotated duration, or any gateway the
scenario did not decide, and the packet says `no estimate` and names what would fix it. A number
beside a caveat gets quoted without the caveat.

**Two risk levels, and it says which it has.** An op knows a reroute is part of an insertion; a
diff only sees the reroute, so a level derived from a diff over-reports. `review` takes the op's
level when it has one and labels its own as derived when it does not.

**`noCollateral` is excluded.** It asks whether anything was touched that the caller did not
intend, and between two arbitrary files there is no intent to compare against. It belongs to
`propose`, which knows what was asked for.

**An unnamed lane is reported by its id.** `miwg/C.1.0` has one, and a packet that says a step
moved out of `""` tells a reviewer nothing.

## Studio ADR-027 — Conformance replays an explicit trace; it does not mine a log

`conform(definitions, trace)` takes a list of element ids in the order they ran and answers two
questions: does what happened match what the model allows, and what does the model allow that
never happens? It reports the first divergence with the step before it, and the nodes the trace
never reached.

**It is not log ingestion, and the difference is the whole point.** Turning a log into a trace
means matching case ids and activity names to elements, and that mapping is the binding layer's
problem — the thing that says which system performs which step. This ships the half that can be
built and tested today, and Studio F14's earlier framing of "ingest a log" was hiding a much larger job
inside a verb.

**A boundary event follows its host.** No sequence flow leads into one; it fires because its host
ran, so the replay accepts it after its host and would otherwise call every real timeout a
divergence.

**Reverses if:** a trace is ever produced from something other than a person or a script naming
ids. At that point the mapping is the feature, and this is its consumer.

## Studio ADR-028 — The viewer is ours, and it renders the DI the file already carries

`render(definitions)` produces a read-only SVG. Every coordinate comes from the document's own DI;
nothing here lays anything out, which is ADR-003's rule applied to drawing.

**It does not use `bpmn-js`, and the plan that called for it contradicted itself.** That plan said
the viewer would "receive the IR and the DI, never the file" *and* that it would use `bpmn-js` —
but `bpmn-js` renders BPMN XML, so the two cannot both be true. Following the dependency would
have meant handing it the file after all, in a separate package, under a licence requiring a
visible watermark on every diagram (ADR-009). The escape hatch the design named as a fallback was
the better answer all along: each block already declares its `shape`, and a review needs to show
which box is which and what changed, not to be a modeller.

So there is no second package, no watermark obligation, and nothing new in the dependency tree.

**What it draws is BPMN's own notation, authored here.** Pools and lanes with their name bands,
message flows dashed between them, the ten event kinds, the marks that tell the five gateways
apart, the activity types, collapsed subprocesses, data objects and stores, text annotations,
groups, associations, and the tick and diamond a default and a conditional flow carry. A document
with no DI is told so in the picture rather than given invented coordinates, and an artifact the DI
never placed is not drawn — the rule is the same one ADR-003 states for nodes.

**The vocabulary lives in `blocks/`, not in the renderer.** Each block declares its `role` (the
family whose outline it takes), its `glyph` (its mark, authored by us in a 16×16 box), and where
relevant its `ring` and `border`. An event's mark comes from its kind rather than its block,
because one StartEvent has ten possible marks. `registry.mjs` refuses a block that declares no
role, and refuses a gateway with no mark at all — without one, all five diamonds are the same
shape. The renderer therefore keeps no table of its own and cannot fall behind the vocabulary: a
new block is drawable or it is a build error.

**The drawing is also an index.** Every element carries `data-id` and `data-kind`, and a node also
carries what it is in, whose lane it is in, what it is attached to, the kind it waits for, and how
it changed. A mark carries `data-glyph`; a flow decoration carries `data-mark`. An agent holding
the SVG can answer what a shape is and what surrounds it without opening the file again — which is
the point of drawing it at all in a tool an agent proposes changes through.

**`treadle render <file> --against <other>`** colours what a `review` would have described: green
for added, red for removed, amber for rerouted or retyped, teal for renamed or moved.

**Reverses if:** someone needs to *edit* on a canvas. That is `bpmn-js`'s job and a separate
package's problem, and this renderer would not be the thing to grow into it.

## Studio ADR-029 — The Studio is a review surface, and it lives outside the published package

`frontend/` is a Next.js app that opens the `.bpmn` files in a workspace directory and shows what
the core already knows about each one: the projection, the gate results, the review packet against
a second file, and the SVG from Studio ADR-028 with pan, zoom, and selection over the ids that SVG
carries.

**It reviews; it does not model.** The canvas was the input device in every BPMN tool built before
an agent could write the edit. Here the agent proposes and the person judges, so the canvas is
where a proposal is read, not where it is drawn. A modeller already exists — `bpmn-js` — and using
it would take back the watermark obligation ADR-009 and Studio ADR-028 both refuse.

**It is a separate npm workspace, not part of `treadle`.** The published package is the core, the
CLI, and the MCP server; nothing in `backend/` imports anything under `frontend/`. The app depends
on the core through `file:..` and consumes the TypeScript contracts PR-07 emits from JSDoc, which
is how a hand-written `Ir` type was caught disagreeing with the real `Projection` at build time.

**Everything stays on the machine.** `TREADLE_WORKSPACE` names one directory, every path is
confined to it by `realpath`, and there is no network call, no telemetry, and no upload.

**Two things the first version got wrong, both found by looking at the rendered page.** A Tailwind
v4 `@theme` block nested in `@media (prefers-color-scheme: dark)` is hoisted out of the media
query, so the app was dark unconditionally; the light palette is declared in `@theme` and the dark
one redefines the same custom properties under the media query. And the SVG's structural colours
are now `var(--treadle-ink, …)` and friends, so the same drawing reads on a dark page and in a
`.svg` file the CLI wrote, where the fallbacks resolve to the light palette.

**Light by default, and the choice is the reader's.** `prefers-color-scheme` is deliberately not
consulted: a document that changes colour between one visit and the next is a surprise, not a
preference. The palette is light, dark is stamped on the root element by a switch, and the choice is
remembered.

**Four interaction defects, each found by driving the real browser rather than by looking at a
screenshot.** All four looked fine in a picture and were broken in use:

- React registers its wheel listener as passive, so `preventDefault` in `onWheel` is ignored and a
  pinch zooms the whole page. The wheel is handled natively instead.
- `setPointerCapture` retargets every later pointer event — and the click the browser derives from
  them — at the capture element, so a hit test in `onClick` always found the frame. The test happens
  on the way down, and a selection is committed on the way up only if the pointer barely moved.
- A label is a sibling of the shape it names, not a child, so `closest('[data-id]')` from the text
  reached the drawing root: clicking the middle of a task selected nothing. Every drawn piece now
  carries the id of what it belongs to.
- A constant imported from a `'use client'` module into a server component arrives as a client
  reference proxy, not its value. The pre-paint theme script read
  `localStorage.getItem('function() { throw ... }')` and the theme never survived a reload.

**Reverses if:** someone needs to edit on the canvas, or the workspace stops being a local
directory. The first is Studio ADR-028's reversal, not this one's; the second makes path confinement a
server's problem rather than a `realpath` call.


## Studio ADR-030 — Artifacts are projected but never addable

`project()` returns `data`, `notes`, `groups` and `links` alongside the flow: data objects and
stores, the inputs and outputs an activity declares, text annotations, groups, and the associations
that tie them to the work.

**They are not blocks.** The registry is the closed vocabulary `add` accepts, and a data object in
it would let `ops` mint one with nothing to reference — a `DataObjectReference` that references no
`DataObject` is a dangling reference the integrity gate would then have to report. Reading them
costs nothing and is what a reviewer needs; writing them is a separate decision with its own
invariants.

**Measured, not assumed.** Across the 23 corpus files the renderer was silently dropping 23 pools,
22 lanes, 18 message flows, 16 data objects, 11 data stores, 14 data inputs and outputs, 62 data
associations, 5 associations, 3 text annotations and 2 groups — every one of them positioned by the
DI. Thirteen of the 23 files have pools, so more than half the corpus was being drawn as a bare
flow with its organisational structure removed.

**Reverses if:** an op needs to create or retarget a data association. That makes data a write
concern, and the blocks are where a write concern belongs.
