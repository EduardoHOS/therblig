# therblig-mcp

**An MCP server for BPMN 2.0: read, explain, lint and edit the `.bpmn` files already in a
repo, without wrecking the diagram.**

stdio only. No account, no network calls, no data leaves the machine. Apache-2.0.

```bash
claude mcp add therblig -- npx -y therblig-mcp --root .
```

<details>
<summary>Cursor, VS Code, and anything else that speaks MCP</summary>

```json
{ "mcpServers": { "therblig": { "command": "npx", "args": ["-y", "therblig-mcp", "--root", "."] } } }
```

VS Code uses `servers` as its top-level key rather than `mcpServers`; everything else is
the same.

</details>

## Tools

| tool | what it gives the model |
|---|---|
| `bpmn_read` | the file as a compact projection — nodes, flows, lanes, pools by id, no coordinates. `view: "outline"` is smaller still |
| `bpmn_explain` | counts, control-flow complexity, and a Mermaid diagram |
| `bpmn_lint` | what is wrong, the BPMN rule it breaks, and the fix |
| `bpmn_verify` | does it parse and match the five OMG schemas |
| `bpmn_patch` | edits a file, and refuses if the edit changed anything you did not ask for |

`bpmn_patch` previews by default. To write, pass `dry_run: false` and the `base_rev` you
were given when you read the file — so an edit built against bytes that have since changed
on disk is refused rather than overwriting a save from somebody's modeller.

Before anything is written the edit is compared against the original. If it changed
something the operations did not ask for — a lost element, a label left behind while its
shape moved, a sequence flow crossing a pool — it is refused and the file is not opened
for writing at all.

## Confinement

Every path is confined to `--root`. The extension is checked before the filesystem is
touched, both sides are `realpath`'d so a symlink cannot lead out, and the containment
test is case-insensitive on Windows. Those tests were written before the handler they
guard.

Diagnostics go to stderr; stdout carries JSON-RPC and nothing else.

## What it will not do

It never re-runs full-file layout on a file that already has one. Full-file auto-layout
fails on 9 of the OMG's own 22 reference models, 8 of them silently. therblig places new
elements next to their neighbours instead.

The first edit reformats the file, and drops XML comments along with it, because the
parser does not model them. Both are stated to the model in the tool descriptions.

Requires Node 22.12+. This package is a thin launcher; everything lives in
[`therblig`](https://www.npmjs.com/package/therblig).

## License

Apache-2.0. BPMN is a trademark of the Object Management Group. therblig is not
affiliated with or endorsed by OMG, Camunda, SAP or Software AG.
