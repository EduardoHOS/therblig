# therblig

**Read, explain, lint and edit the `.bpmn` files already in your repo — from any AI agent,
without wrecking the diagram.**

An open-source MCP server, CLI and library for BPMN 2.0. Engine-neutral, file-native,
no account, no server, works offline. Apache-2.0.

> Status: **pre-release, not yet published to npm.** The library, CLI and MCP server
> work; writes are guarded and tested. See [docs/FINDINGS.md](docs/FINDINGS.md) for what
> has been measured — including what was measured *wrongly* and corrected — and
> [docs/DECISIONS.md](docs/DECISIONS.md) for what was decided on the strength of it.

---

## Why

Analysts inherit BPMN models far more often than they draw them. Every AI tool in this
space generates new diagrams: Camunda's Copilot "officially supports only modifying
diagrams that were created by the BPMN Copilot itself", and every open-source BPMN MCP
server is a text-to-diagram generator abandoned within days of creation.

Meanwhile, editing a real `.bpmn` file with ordinary text tools breaks in structural ways:

- a flow id appears three times in the XML (`sequenceFlow`, `incoming`, `outgoing`), so a
  string replace on it is ambiguous by construction and silently corrupts adjacency
- past ~60 nodes the file exceeds an agent's tool-response budget, so read-modify-write
  stops working at all
- regenerating the file moves every shape, producing a diff nobody will review

therblig operates on the parsed document instead: patches apply to the object tree, and
export rewrites only what changed.

## What is measured, not claimed

| | |
|---|---|
| One-attribute edit on a normalized 1,710-line file | **−1 +1 lines, 0 shapes moved** |
| Camunda 8 / Zeebe extension round-trip | **lossless**, 15/15 probes, 0 warnings |
| MIWG reference models parsed | **22/22**, 0 errors |
| MIWG reference models XSD-valid | **22/22** |
| `bpmn-auto-layout@2.0.0-alpha.2` full-file layout | **fails on 9/22** — 8 silent, 1 crash |

That last row is why this is an editing tool and not a diagram generator.

**And one that was measured wrongly.** F9 claimed incremental placement preserves layout,
scored by a gate testing that everything which moved moved by the same delta. The gate
read shape bounds with a regex that cannot reach a `BPMNLabel`, and the placement code
moved shape bounds and nothing else — so on two of the four files it certified,
**12 labels were left behind while their shapes slid out from under them, and the gate
reported success.** Corrected in [F11](docs/FINDINGS.md), and now 0 of 12 — labels are
translated with their shapes, and the make-room shift is scoped to the pool being edited
rather than the whole document. A probe holds the property in the test suite; the gate
that missed it was deliberately left alone, because it scores the benchmark and is not
what guards a write.

We publish the corrections because a preservation tool that hides its own preservation
failures is worth nothing. Details and repro steps: [docs/FINDINGS.md](docs/FINDINGS.md).

## Use it

```bash
claude mcp add therblig -- npx -y therblig-mcp --root .
```

Five tools:

| tool | what it gives the model |
|---|---|
| `bpmn_read` | the file as a compact projection — nodes, flows, lanes, pools by id, no coordinates |
| `bpmn_explain` | counts, control-flow complexity, and a Mermaid diagram |
| `bpmn_lint` | what is wrong, the BPMN rule it breaks, and the fix |
| `bpmn_verify` | does it parse and match the five OMG schemas |
| `bpmn_patch` | edits a file, and refuses if the edit changed anything you did not ask for |

`bpmn_patch` previews by default. To write, pass `dry_run: false` and the `base_rev` you
were given when you read the file — so an edit built against bytes that have since
changed on disk is refused rather than overwriting a save from somebody's modeller.

Before anything is written, the edit is compared against the original: if it changed
something the operations did not ask for — a lost element, a label left behind while its
shape moved, a sequence flow crossing a pool — it is refused and the file is not opened
for writing at all. Refused and byte-identical are the same statement.

The write itself goes to a temp file in the same directory and is renamed over the
target, so an interrupted edit leaves either the old file or the new one, never a
fragment. That is tested by actually killing the process mid-write.

Or from a terminal:

```bash
npx therblig lint orders.bpmn
npx therblig explain orders.bpmn
```

```
orders.bpmn
  warning  Gateway in stock? has 1 outgoing flow. A gateway splits or joins, so it
           needs 2 or more. Add the missing branch, or remove the gateway.

1 file. 0 errors, 1 warning.
```

Every path is confined to `--root`: the extension is checked before the filesystem is
touched, both sides are `realpath`'d so a symlink cannot lead out, and the containment
test is case-insensitive on Windows. Those tests were written before the handler.

## Repo layout

```
packages/
  therblig/     the library, CLI and MCP server
  therblig-mcp/ the npx entry point
bench/          the benchmark harness
  corpus/       BPMN fixtures + profilers (see corpus/PROVENANCE.md)
  scorer/       the five scoring gates
  probe/        red probes: defects asserted before they are fixed
  tasks/        edit tasks and their assertions
  arms/         the IR projection, patch ops and incremental DI placement
scripts/        licence guard
third_party/    OMG BPMN 2.0 XSD schemas
docs/           findings, decisions
```

## Running the harness

Needs Node 22.12+ ([why](docs/FINDINGS.md#f6--the-real-reason-for-the-node-2212-floor)).
`.npmrc` sets `engine-strict`, so an older runtime fails at install rather than producing
a different measurement quietly.

```bash
npm ci
npm test            # 99 assertions across six suites
npm run oracle      # lint the whole corpus
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

## How this gets built

Evidence first, then ship, then study.

1. ~~**Truth pass**~~ — done. Corrected the published evidence, pinned the runtime,
   replaced the licence guard, wrote the red probes.
2. ~~**Core + oracle**~~ — done. The write-guard is built *separately* from the gates that
   scored the benchmark; conflating those is how F9 came to be trusted.
3. ~~**`npx -y therblig-mcp`**~~ — done. Read, explain, lint, verify, preview.
4. ~~**Guarded writes**~~ — done. base_rev, an atomic rename, and a barrier that leaves
   the file byte-identical when it refuses.
5. **The preservation receipt** — next: an offline-checkable proof that nothing outside
   an edit moved, plus a headless SVG a reviewer can look at.

A three-arm LLM comparison was planned first and was deliberately reordered: at n=20 the
pre-registered analysis has 0.21 power against the effect it was built to detect, so it
would have returned "no significant difference" whatever the truth. It returns later,
re-scoped to preservation — the axis nobody else measures.

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
