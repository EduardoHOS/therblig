# Contributing

therblig is Apache-2.0 and takes contributions under the **Developer Certificate of
Origin**. There is no CLA, and there is no plan to relicense the core — see
[GOVERNANCE.md](GOVERNANCE.md).

## Sign your commits

Every commit needs a `Signed-off-by` line, which `git commit -s` adds for you:

```bash
git commit -s -m "your message"
```

That line certifies you wrote the patch or have the right to submit it, per the
[DCO](https://developercertificate.org/). Nothing more — you keep your copyright.

## Getting set up

Node 22.12 or newer is required. The floor comes from `bpmnlint@11.13.0`, which
CommonJS-`require`s an ESM-only `min-dash`; that only resolves where `require(esm)`
is enabled. See [docs/FINDINGS.md](docs/FINDINGS.md#f6--the-real-reason-for-the-node-2212-floor).

```bash
npm install
npm test
```

## The one rule that matters

**Measurements are not opinions.** Every claim in `docs/FINDINGS.md` is produced by a
script in this repo, with the date and the command that generated it. If you add a
finding, add the script. If you change behaviour that a finding describes, re-run it
and update the number.

Corollaries:

- No performance or correctness claim in a PR description without the command that
  produced it.
- A bug report is worth much more with a failing fixture than with a description.
  `bench/corpus/handmade/` is the right place for one.

## Code conventions

- ES modules, Node built-ins prefixed `node:`.
- No dependency on `bpmn-js`, `dmn-js`, `form-js` or `cmmn-js` anywhere under
  `packages/` or `bench/`. Those carry the bpmn.io watermark licence, which is not
  OSI-approved; keeping the core free of them is the point. See
  [ADR-009](docs/DECISIONS.md#adr-009--bpmn-js-is-quarantined-mechanically).
- Never set `sourceRef` or `targetRef` directly. BPMN stores adjacency on both the
  flow and the endpoint nodes, and writing one side produces a file that is
  XSD-valid but lints as disconnected. Route every mutation through
  `linkFlow` / `unlinkFlow` / `retarget`. See
  [F8](docs/FINDINGS.md#f8--bpmn-stores-adjacency-twice-and-moddle-maintains-only-one-side).
- Never re-run full-file auto-layout on a file that already has DI. Place new
  elements only. See [ADR-005](docs/DECISIONS.md#adr-005--di-coverage-is-a-hard-ci-gate-the-layouters-warnings-channel-is-not-trusted).

## Adding a fixture

Fixtures must have a verified, first-party licence that permits redistribution in an
Apache-2.0 repository. Record the source, the licence, and the pinned commit or DOI in
[bench/corpus/PROVENANCE.md](bench/corpus/PROVENANCE.md). Assets that are already ruled
out — and why — are listed there too; please read it before proposing a dataset.

## Reporting a security issue

Do not open a public issue. Email the maintainers; we will confirm within 72 hours.
