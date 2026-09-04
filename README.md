# therblig

**Read, explain, lint and edit the `.bpmn` files already in your repo — from any AI agent,
without wrecking the diagram.**

An open-source MCP server, CLI and library for BPMN 2.0. Engine-neutral, file-native,
no account, no server, works offline. Apache-2.0.

> Status: **pre-release, private.** No product code yet. This repo holds the benchmark
> harness and the evidence that decides how the product gets built. See
> [docs/FINDINGS.md](docs/FINDINGS.md) for what has been measured — including what was
> measured *wrongly* and corrected — and [docs/DECISIONS.md](docs/DECISIONS.md) for what
> was decided on the strength of it.

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
reported success.** Corrected in [F11](docs/FINDINGS.md); the fix is scheduled before any
product code depends on it.

We publish the corrections because a preservation tool that hides its own preservation
failures is worth nothing. Details and repro steps: [docs/FINDINGS.md](docs/FINDINGS.md).

## Repo layout

```
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
npm test            # the arm-C suite: 51 assertions
npm run probe       # the red probes — these FAIL on purpose, see below
npm run licence-guard
npm run bench:baseline
```

`npm run probe` is expected to be red. Each probe asserts *correct* behaviour against a
defect that is not fixed yet, so it fails today and turns green when the fix lands. As of
2026-09-04 that is 12 detached labels (F11), five invariant violations (F12) and one lost
XML comment (F10). A probe written after its fix proves nothing about the bug it claims to
cover.

## How this gets built

Evidence first, then ship, then study.

1. **Truth pass** — correct the published evidence, pin the runtime, replace the licence
   guard, and write the red probes. No product code.
2. **Core + oracle** — extract the library, and build the write-guard *separately* from
   the gates that scored the benchmark. Conflating those is how F9 came to be trusted.
3. **`npx -y therblig-mcp`** — read, explain, lint, and preview edits. The install trigger.
4. **Guarded writes**, then **the preservation receipt**: an offline-checkable proof that
   nothing outside an edit moved, plus a headless SVG a reviewer can look at.

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
