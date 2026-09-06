# Treadle

**Read, explain, lint and edit the `.bpmn` files already in your repo — from any AI agent,
without wrecking the diagram.**

An open-source MCP server, CLI and library for BPMN 2.0. Engine-neutral, file-native,
no account, no server, works offline. Apache-2.0.

> Status: **v0.1.** The core, the CLI and the MCP server exist and are covered. The bake-off
> that the whole premise rests on has **not** been run, so nothing here claims a structured API
> makes an agent more correct — see [docs/FINDINGS.md](docs/FINDINGS.md) for what has been
> measured and [docs/DECISIONS.md](docs/DECISIONS.md) for what was decided on the strength of it.

```sh
npm install treadle

npx treadle explain process.bpmn        # a deterministic reading: handlers, dead ends, spine
npx treadle lint process.bpmn           # parse, XSD, references, routing semantics, bpmnlint
npx treadle apply process.bpmn --op timeout \
  --args '{"on":"Review","after":"P3D","to":"Escalate","name":"Late"}' --write
npx treadle review as-is.bpmn to-be.bpmn
npx treadle-mcp                         # 17 tools over stdio, for an agent
```

Every edit is a dry run until `--write`, and every edit is refused if a gate fails.

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

Treadle operates on the parsed document instead: patches apply to the object tree, and
export rewrites only what changed.

## What is measured, not claimed

| | |
|---|---|
| One-attribute edit on a normalized 1,710-line file | **−1 +1 lines, 0 shapes moved** |
| Camunda 8 / Zeebe extension round-trip | **lossless**, 15/15 probes, 0 warnings |
| MIWG reference models parsed | **22/22**, 0 errors |
| MIWG reference models XSD-valid | **22/22** |
| `bpmn-auto-layout@2.0.0-alpha.2` full-file layout | **fails on 9/22** — 8 silent, 1 crash |
| Broken references nothing else catches | **7 of 8 kinds** — only a duplicate id is caught by the XSD |
| `del` leaving orphaned DI behind | found by that gate, on the first real edit |
| A fork on the corpus: shapes moved by one delta | **18 / 18** file-and-op combinations |
| MIWG models the token machine runs or refuses by name | **21 / 21** — 16 run, 5 named |

That last row is why this is an editing tool and not a diagram generator.
Details and repro steps: [docs/FINDINGS.md](docs/FINDINGS.md).

## Repo layout

```
backend/        the product and its tests
  core/         parse, project, patch, place, gate, simulate, diff
  io/           the only filesystem boundary: confinement and atomic replacement
  cli/          treadle
  mcp/          treadle-mcp — stateless stdio, handles, risk policy
  test/         unit, integration and smoke tests
bench/          the week-1 bake-off harness
  corpus/       BPMN fixtures + profilers (see corpus/PROVENANCE.md)
  scorer/       the five scoring gates
  tasks/        edit tasks and their assertions
  arms/         A naive · B strong baseline · C IR prototype
third_party/    OMG BPMN 2.0 XSD schemas, unmodified
docs/           findings, decisions
```

## Running the harness

Needs Node 22.12+ ([why](docs/FINDINGS.md#f6--the-real-reason-for-the-node-2212-floor)).

```bash
npm ci
npm run check
```

`npm run check` runs lint, the backend test suite with 100% core coverage, and
the 22-file corpus integrity gate. Individual benchmark probes remain available:

```bash
node bench/corpus/profile.mjs bench/corpus
node bench/corpus/probe-diff-floor.mjs bench/corpus
node bench/scorer/probe-layout.mjs bench/corpus
node bench/scorer/baseline.mjs bench/corpus
```

Repository and pull request conventions are defined in [CLAUDE.md](CLAUDE.md);
[AGENTS.md](AGENTS.md) routes other coding agents to the same guide.

## The bake-off

The original three arms were scored on the same tasks by the same gates:

- **A — naive.** Read the whole file, edit with find-and-replace, write back.
- **B — strong baseline.** Edit the XML directly, then post-process with bpmnlint and
  auto-layout, feeding lint errors back for one repair turn. Roughly one week of work.
  **This is the arm to beat.** If it wins, it is the product.
- **C — structured.** Parse to a tree, project a compact view, apply patch operations,
  re-serialize.

Decision rules are committed in advance in [docs/DECISIONS.md](docs/DECISIONS.md).

## License

Apache-2.0. Contributions by DCO sign-off — no CLA, and no plan to relicense the core.

Third-party components and fixture provenance are recorded in [NOTICE](NOTICE) and
[bench/corpus/PROVENANCE.md](bench/corpus/PROVENANCE.md). Treadle's own packages depend
only on OSI-licensed software; `bpmn-js` and the other bpmn.io watermark-licensed
toolkits are excluded from the core by CI policy
([ADR-009](docs/DECISIONS.md#adr-009--bpmn-js-is-quarantined-mechanically)).

BPMN is a trademark of the Object Management Group. Camunda, Signavio and ARIS are
trademarks of their respective owners. Treadle is not affiliated with or endorsed by any
of them.
