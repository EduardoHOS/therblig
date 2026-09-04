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

