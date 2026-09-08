# therblig

**Read, explain, lint and edit the `.bpmn` files already in your repo — from any AI agent,
without wrecking the diagram.**

An open-source MCP server, CLI, library and local Studio for BPMN 2.0. Engine-neutral, file-native,
no account, no remote service, works offline. Apache-2.0.

> Status: **pre-release, not yet published to npm.** The library, CLI and MCP server
> exist alongside the local Studio. The three-arm agent bake-off has not been completed.
> See [docs/FINDINGS.md](docs/FINDINGS.md) for what
> has been measured — including what was measured *wrongly* and corrected — and
> [docs/DECISIONS.md](docs/DECISIONS.md) for what was decided on the strength of it.

---

## Why

Analysts inherit BPMN models and need to inspect, change and review the files they already have.

Meanwhile, editing a real `.bpmn` file with ordinary text tools breaks in structural ways:

- a flow id appears three times in the XML (`sequenceFlow`, `incoming`, `outgoing`), so a
  string replace on it is ambiguous by construction and silently corrupts adjacency
- past ~60 nodes the file exceeds an agent's tool-response budget, so read-modify-write
  stops working at all
- regenerating the file moves every shape, producing a diff nobody will review

therblig operates on the parsed document instead: patches apply to the object tree, and
export serializes the updated tree. The first edit normalizes formatting and can remove
XML comments, DOCTYPE declarations and processing instructions; see ADR-004. Subsequent
edit diffs are measured separately from that one-time normalization.

## Recorded evidence

These are historical measurements from the revisions recorded in [docs/FINDINGS.md](docs/FINDINGS.md),
not results from the merged checkout. Corpus totals depend on the run.

| | |
|---|---|
| One-attribute edit on a normalized 1,710-line file | **−1 +1 lines, 0 shapes moved** |
| Camunda 8 / Zeebe extension round-trip | **lossless**, 15/15 probes, 0 warnings |
| Corpus parsed — 21 OMG MIWG reference models + 2 hand-authored | **23/23**, 0 errors |
| Corpus XSD-valid | **23/23** |
| `bpmn-auto-layout@2.0.0-alpha.2` full-file layout | **fails on 9 of the 21 MIWG models** — 8 silent, 1 crash |

The Studio branch also recorded seven reference-error kinds missed by the existing
validators, a fork placement probe over 18 file/op combinations, and simulation results
for 21 MIWG files (16 ran, five refused by name). Those findings remain under **Studio
F10–F17** in the same document. The rigid-shape probe alone cannot prove label preservation.

The full-layout failure is why edits preserve existing DI and place only new elements.

**And one that was measured wrongly.** F9 claimed incremental placement preserves layout,
scored by a gate testing that everything which moved moved by the same delta. The gate
read shape bounds with a regex that cannot reach a `BPMNLabel`, and the placement code
moved shape bounds and nothing else — so on two of the four files it certified,
**12 labels were left behind while their shapes slid out from under them, and the gate
reported success.** The corrected run in [F11](docs/FINDINGS.md) measured 0 of 12 — labels were
translated with their shapes, and the make-room shift is scoped to the pool being edited
rather than the whole document. A probe holds the property in the test suite; the gate
that missed it was deliberately left alone, because it scores the benchmark and is not
what guards a write.

We publish the corrections because a preservation tool that hides its own preservation
failures is worth nothing. Details and repro steps: [docs/FINDINGS.md](docs/FINDINGS.md).

## Run from the checkout

Use the pinned development runtime in `.nvmrc` / `.node-version` (Node 22.20.0).
The package consumer floor is Node 22.12. Dependencies are installed from the lockfile:

```bash
npm ci
node backend/cli/bin.mjs read bench/corpus/miwg/C.9.0.bpmn
node backend/cli/bin.mjs lint bench/corpus/miwg/C.9.0.bpmn
node backend/cli/bin.mjs explain bench/corpus/miwg/C.9.0.bpmn
```

The package is named `therblig`. It retains both CLI entrypoints because they expose
different workflows: `therblig` reads files, applies primitive patches and produces
receipts; `treadle` exposes governed intent operations, review, conformance and rendering.
Until npm publication, invoke their files from the checkout:

```bash
node backend/cli/main.mjs explain bench/corpus/miwg/C.9.0.bpmn
node backend/cli/main.mjs apply process.bpmn --op timeout \
  --args '{"on":"Review","after":"P3D","to":"Escalate","name":"Late"}'
node backend/cli/main.mjs review as-is.bpmn to-be.bpmn
node backend/cli/main.mjs render to-be.bpmn --against as-is.bpmn > diff.svg
```

The intent example requires the named nodes in `process.bpmn`. Edits preview by
default. The governed CLI additionally enforces its `--allow` risk policy when applying
an operation. Use `--write` only after reviewing the preview.

### MCP clients

The `therblig-mcp` entrypoint is `backend/mcp/bin.mjs`; run it with Node and `--root`
pointing to the workspace whose BPMN files the client may access. For example, from
the checkout: `node backend/mcp/bin.mjs --root .`. Client configuration must use
absolute paths to the entrypoint and workspace because the client may start elsewhere.

The retained `treadle-mcp` entrypoint is `backend/mcp/server.mjs`, which provides the
governed workflow with handles, proposals, revisions and a publication risk policy.
The library exposes both MCP factories, `createServer` and `build`. Both servers use
stdio, with diagnostics on stderr. The plugin scaffold is documented in
[plugin/README.md](plugin/README.md); its npm-based setup requires package publication.

The path-addressed server exposes five tools:

| tool | what it gives the model |
|---|---|
| `bpmn_read` | the file as a compact projection — nodes, flows, lanes, pools by id, no coordinates |
| `bpmn_explain` | counts, control-flow complexity, and a Mermaid diagram |
| `bpmn_lint` | what is wrong, the BPMN rule it breaks, and the fix |
| `bpmn_verify` | does it parse and match the five OMG schemas |
| `bpmn_patch` | edits a file, and refuses if the edit changed anything you did not ask for |

Its primitive operations are `add`, `set`, `del`, `connect`, `move` and `message`. `move` and
`message` are separate verbs rather than flags because the structures differ: lane
membership lives on the lane, and a message flow belongs to the collaboration rather than
to either process ([ADR-011](docs/DECISIONS.md)).

`bpmn_patch` previews by default. To write, pass `dry_run: false` and the `base_rev` you
were given when you read the file — so an edit built against bytes that have since
changed on disk is refused rather than overwriting a save from somebody's modeller.

Before anything is written, the edit is compared against the original: if it changed
something the operations did not ask for — a lost element, a label left behind while its
shape moved, a sequence flow crossing a pool — it is refused and the file is not opened
for writing at all. Refused and byte-identical are the same statement.

The write itself goes to a temp file in the same directory and is renamed over the
target, so an interrupted edit leaves either the old file or the new one, never a
fragment. The end-to-end write suite exercises process termination during a write. Revision
checks detect already-stale bytes; they are not a filesystem lock against a save
between the check and rename.

## The receipt

Example commands and illustrative output (revision values depend on the input files):

```bash
node backend/cli/bin.mjs patch orders.bpmn --ops ops.json --write --base-rev a752214b12e7 --receipt
```

```
orders.bpmn  a752214b12e7
  +2 · 0 of 55 protected objects changed, UCR 0%
  1 of 26 shapes moved, 1 distinct delta, 0 labels detached.
  wrote orders.receipt.json
  wrote orders.diff.svg

Written. a752214b12e7 → 87001c4d4939.
```

The receipt is the preservation claim written down so somebody else can check it —
offline, with no key and no network, against the two files it describes:

```bash
node backend/cli/bin.mjs verify --receipt orders.receipt.json orders.before.bpmn orders.bpmn
```

```
Receipt holds. 11 claims re-derived from the two files.
```

It is re-derivable rather than signed on purpose. A signature would prove therblig wrote
the receipt; re-derivation proves the receipt is **true**, which is the half that matters
and the half you can check without trusting us. Change one number in it and verification
names the number.

The drawing beside it is SVG rendered straight from the DI coordinates already in the
file — no bpmn-js, no DOM, no headless browser, so ADR-009 stays intact. Added elements
are drawn in ink, shapes that moved leave a dashed ghost where they were, and everything
the edit did not touch recedes, so the eye goes to the change.

The renderer emits SVG for reviewers. Clients that require a raster image need a separate
conversion; the CLI does not provide that conversion.

Or from a terminal:

```bash
node backend/cli/bin.mjs lint orders.bpmn
node backend/cli/bin.mjs explain orders.bpmn
```

```
orders.bpmn
  warning  Gateway in stock? has 1 outgoing flow. A gateway splits or joins, so it
           needs 2 or more. Add the missing branch, or remove the gateway.

1 file. 0 errors, 1 warning.
```

MCP file access is confined to `--root`: the extension is checked before the filesystem is
touched, both sides are `realpath`'d so a symlink cannot lead out, and the containment
test is case-insensitive on Windows. Those tests were written before the handler.

## Local Studio

```bash
make dev                             # http://localhost:3000
make dev PORT=3001 WORKSPACE=/absolute/path/to/models
make build                           # production build of @therblig/studio
```

The Studio is a local review surface for the workspace’s process library. It opens
existing files, shows validation and review results, and renders their DI with pan,
zoom and element selection. The app imports the core in process; it needs no separate
backend daemon. `frontend/` is a private workspace and is excluded from the published
CLI/library package. `TREADLE_WORKSPACE` remains the workspace configuration variable.

## Repo layout

```
backend/
  core/         parse, project, patch, place, intent ops, gates, simulate, review, render
  oracle/       validation and semantic diff, no I/O
  io/           paths, revisions, schema validation, the write barrier
  render/       BPMN to SVG, no bpmn-js and no DOM
  cli/ mcp/     path-addressed and governed callers
  contracts/    TypeScript consumer of generated public declarations
  test/         unit · integration · e2e
frontend/       the private @therblig/studio workspace
bench/          the benchmark harness
  corpus/       BPMN fixtures + profilers (see corpus/PROVENANCE.md)
  scorer/       the five scoring gates
  probe/        red probes: defects asserted before they are fixed
  tasks/        edit tasks and their assertions
  arms/         the IR projection, patch ops and incremental DI placement
scripts/        development runner, licence guard and package audits
third_party/    OMG BPMN 2.0 XSD schemas
docs/           findings, decisions
```

## Running the harness

Needs Node 22.12+ ([why](docs/FINDINGS.md#f6--the-real-reason-for-the-node-2212-floor)).
`.npmrc` sets `engine-strict`, so an older runtime fails at install rather than producing
a different measurement quietly.

```bash
npm ci
npm test            # node --test across backend/test
npm run check       # lint, types, core/io coverage, corpus and replay gates
make build          # production Studio build
npm run oracle      # lint the whole corpus
npm run verify:corpus  # every canonical edit on every file, every invariant
npm run probe       # the one probe that FAILS on purpose, see below
npm run licence-guard
npm run pack-audit  # what would actually ship
```

`npm run probe` is expected to be red, and only that one. The label and invariant probes
were red when they were written, went green when the fixes landed, and moved into
`npm test` — a probe written after its fix proves nothing about the bug it claims to
cover. What is left is comment conservation (F10), which is red because of a *decision*
rather than a bug: moddle does not model XML comments, and ADR-004 chose to warn rather
than refuse, because the naive text-editing baseline preserves them for free and refusing
would make the structured path strictly worse.

## Verification and the bake-off

`npm run check` is the required quality gate; `make check` invokes it. Core and I/O
coverage targets remain 100% for lines, branches and functions. The corpus sweep and
real CLI/MCP entrypoint tests supplement coverage with preservation and protocol checks.
Repository and review conventions live in [CLAUDE.md](CLAUDE.md);
[AGENTS.md](AGENTS.md) routes other agents to that guide.

The original benchmark compares three arms: a naive text edit, a stronger XML baseline
with lint/layout repair, and structured tree patches. It has not established that the
structured API makes an agent more correct. The upstream plan deferred the original
comparison because its pre-registered n=20 analysis had low power (0.21), and re-scoped
future study to preservation. Historical pilot failures and useful measurements from
both branches are retained in [docs/FINDINGS.md](docs/FINDINGS.md).

## License

Apache-2.0. Contributions by DCO sign-off — no CLA, and no plan to relicense the core.

Third-party components and fixture provenance are recorded in [NOTICE](NOTICE) and
[bench/corpus/PROVENANCE.md](bench/corpus/PROVENANCE.md). therblig's own packages depend
only on OSI-licensed software. The bpmn.io watermark licence attaches to the watermark
rather than to a list of package names, so this is enforced by an SPDX allowlist and a
licence-text scan over the installed tree, not by a hardcoded deny list
([ADR-009](docs/DECISIONS.md#adr-009--bpmn-js-is-quarantined-mechanically)).

BPMN is a trademark of the Object Management Group. Camunda, Signavio and ARIS are
trademarks of their respective owners. therblig is not affiliated with or endorsed by any
of them.
