# therblig

**Read, explain, lint and edit the `.bpmn` files already in your repo — from any AI agent,
without wrecking the diagram.**

Engine-neutral, file-native, offline. No account, no server, no network calls at runtime.
Apache-2.0.

```bash
npx therblig lint orders.bpmn
npx therblig explain orders.bpmn
```

For the MCP server, install [`therblig-mcp`](https://www.npmjs.com/package/therblig-mcp).

## Why not just edit the XML

Editing a real `.bpmn` with ordinary text tools breaks in structural ways:

- a flow id appears **three times** (`sequenceFlow`, `incoming`, `outgoing`), so a string
  replace on it is ambiguous by construction and silently corrupts adjacency;
- past ~60 nodes the file exceeds an agent's tool-response budget, so read-modify-write
  stops working at all;
- regenerating the file moves every shape, producing a diff nobody will review.

therblig operates on the parsed document. Patches apply to the object tree, and export
rewrites only what changed — a one-attribute edit comes out as a one-line diff with no
shape moved.

## Commands

```
therblig read    <file|dir>...   the compact projection, and the file's revision
therblig explain <file|dir>...   counts, complexity and a Mermaid diagram
therblig lint    <file|dir>...   what is wrong, and the BPMN rule it breaks
therblig verify  <file|dir>...   does it parse and match the OMG schemas
therblig fmt     <file|dir>...   what normalising would cost, without doing it
therblig patch   <file> --ops ops.json [--write --base-rev <rev>] [--receipt]
therblig verify  --receipt <r.json> <before> <after>
```

Edits preview by default. `--write` also requires `--base-rev`, the revision `read`
printed, so an edit built against bytes that have since changed on disk is refused rather
than overwriting a save from somebody's modeller.

Before anything reaches the disk the result is compared against the original. If it
changed something the operations did not ask for, it is refused and the file is never
opened for writing — refused and byte-identical are the same statement. The write itself
is a temp file plus an atomic rename, so an interrupted edit leaves the old file or the
new one, never a fragment.

## The receipt

`--receipt` writes a machine-checkable record beside the file:

```
orders.bpmn  a752214b12e7
  +2 · 0 of 55 protected objects changed, UCR 0%
  1 of 26 shapes moved, 1 distinct delta, 0 labels detached.
```

```bash
therblig verify --receipt orders.receipt.json before.bpmn orders.bpmn
# Receipt holds. 11 claims re-derived from the two files.
```

Re-derivable rather than signed, on purpose. A signature would prove therblig wrote the
receipt; re-derivation proves it is **true**, which is the half you can check without
trusting the tool. Change one number in it and verification names the number.

## Library

```js
import { parse, project, applyPatch, placeNew, serialize } from 'therblig';

const doc = await parse(xml);
const ir = project(doc.definitions);                    // compact, no coordinates
applyPatch(doc, [{ op: 'add', type: 'user', name: 'Review',
                   in: ir.processes[0].id, between: ['a', 'b'] }]);
placeNew(doc, ['…']);                                    // DI next to the neighbours
const out = await serialize(doc);
```

Operations are `add`, `set`, `del`, `connect`, `move` and `message`. `move` and `message`
are separate verbs rather than flags because the structures differ: lane membership lives
on the lane, and a message flow belongs to the collaboration rather than to either
process.

Subpath exports: `therblig/model`, `/ir`, `/patch`, `/place`, `/diff`, `/oracle`,
`/receipt`, `/render`, `/mcp`.

## What it will not do

It never re-runs full-file layout on a file that already has one. Full-file auto-layout
fails on 9 of the OMG's own 22 reference models, 8 of them silently — one loses 52 of 107
elements and emits no warning. therblig places new elements next to their neighbours
instead, and moves downstream shapes by one uniform delta when it has to make room.

Two costs, stated up front rather than discovered: the first edit reformats the file
(every edit after that is minimal), and that first write also drops XML comments, DOCTYPE
and processing instructions, because the parser does not model them. Run
`therblig fmt --check` first if the file might carry one.

Requires Node 22.12+.

## License

Apache-2.0. The core will not be relicensed; contributions are by DCO sign-off, with no
CLA, so that it cannot be. See
[GOVERNANCE.md](https://github.com/EduardoHOS/therblig/blob/main/GOVERNANCE.md).

BPMN is a trademark of the Object Management Group. therblig is not affiliated with or
endorsed by OMG, Camunda, SAP or Software AG.
