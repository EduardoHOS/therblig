# Local agent integration and process creation — design

Date: 2026-09-23. Branch: `feat/studio-process-library`. Status: implemented the same day; the
"Implementation notes" section at the end records where the code departs from this text.

## Goal

From another project on the same machine, Claude Code creates a new `.bpmn` file and grows it
into a valid process through therblig's MCP server, without an npm publication. Every write
passes the gates that already guard edits. The Studio reviews the result with
`make dev WORKSPACE=<that project>`.

The MCP surface is `therblig-mcp` (`backend/mcp/bin.mjs`, ADR-010 rev. 2), extended with one
creation tool and the ten named operations that today exist only in `treadle-mcp`. The plugin
installs from a local marketplace. The server's write policy allows creation, additive edits and
routing edits without a human; destructive edits still need one.

## Evidence

Everything below was run on 2026-09-23 against this checkout, `make check` green (299 tests,
100% lines, branches and functions on core, io and the Studio library model).

- **A seed built by the core passes every gate.** A definitions tree constructed through
  `moddle.create`, linked with `linkFlow`, given a fresh `bpmndi:BPMNDiagram` and
  `bpmndi:BPMNPlane`, and placed with `placeNew(document, [start, end, flow])` serializes to 27
  lines; `parses`, `xsdValid`, `references`, `semantics`, `lintClean` all pass and `diCoverage`
  reports 3 of 3. `placeNew` returns `no BPMNPlane` when the plane is missing, so the seed must
  create the plane before placing.
- **The named ops grow the seed into a real process.** From a two-node seed, the CLI applied
  `insertAfter` twice, `branch` (with `label`), `timeout` and `onError`: 10 nodes, 139 lines,
  five gates green, `render` produced an SVG.
- **Two refusals shape the design.** `branch` without `label` is refused by the differential
  lint gate (`label-required:Flow_Yes_in`, ADR-006). On a seed holding only a start event,
  `add` + `connect` of one task is refused (`no-implicit-end`). The seed therefore starts
  connected (start → end), and the agent needs the named ops rather than primitives.
- **Neither MCP server can create a file today.** `backend/io/paths.mjs::confine` refuses a
  path that does not exist (`THB_NOT_FOUND`), and both `bpmn_patch` and `publish` go through
  a confine call before writing.
- **The CLI's `--allow` is a replacement list, not an extension.** `--allow routing` refused an
  additive edit because the allowance became `routing` alone. The MCP flag keeps that semantics
  and the skill says so.
- **Claude Code facts, from the official docs (code.claude.com/docs).** A marketplace added from
  a local directory loads plugins in place and `${CLAUDE_PLUGIN_ROOT}` is the source directory;
  `${CLAUDE_PROJECT_DIR}` and `${VAR:-default}` expand in a plugin's `.mcp.json`
  `command`, `args` and `env`; `claude --plugin-dir <dir>` loads a plugin, its skills and its
  MCP servers without a marketplace; MCP permission rules are `mcp__<server>__<tool>` under
  `permissions.allow`, `ask` and `deny`.

## Constraints

- No new runtime dependency. `bpmn-moddle`, `zod` and `@modelcontextprotocol/server@2.0.0` are
  already installed.
- `backend/core` stays free of filesystem, CLI, network and MCP I/O. `adjacency.mjs` remains the
  only module that assigns `sourceRef`, `targetRef`, `incoming` or `outgoing`.
- No id an existing file carries is changed. The seed mints ids only for what it creates, with
  the same `mintId` the ops use.
- No full-file auto-layout, ever. The seed places two shapes and one edge with `placeNew`,
  which is incremental placement on an empty plane, not a layouter.
- The five existing therblig tools keep their names, schemas and semantics. `tools/list` stays a
  fixed, deterministically ordered set (SEP-2567).
- Core and io coverage stay at 100% lines, branches and functions. The smoke suite gates the
  MCP and CLI entrypoints.
- No commit, push or pull request without an explicit request.

## Architecture

```text
backend/
  core/
    seed.mjs          new: seed({ name, start, end, executable }) → { document, ids }
    ops.mjs           + LEVELS and allowanceOf move here from backend/cli/apply.mjs
    index.mjs         + export { seed }, { allowanceOf }
  io/
    bpmn-file.mjs     + createBpmn(path, xml, { root })   — open with 'wx', never overwrite
    errors.mjs        + THB_EXISTS, THB_REQUIRES_APPROVAL, THB_OP_REFUSED
  mcp/
    tools.mjs         OPS and ARGS become exports (unchanged content)
    server.mjs        + bpmn_create, + ten bpmn_<op> tools, allowance on every write
    bin.mjs           + --allow <list>, TREADLE_ALLOW
  cli/
    apply.mjs         imports allowanceOf from the core
plugin/plugins/therblig/
  .mcp.json           launches the checkout's bin.mjs in place, allowance in env
  skills/bpmn-editing/SKILL.md   + "Creating a process", labels, approval refusals
plugin/README.md      local install steps; the one-line change at publication
```

### `backend/core/seed.mjs`

`seed({ name, start = 'Start', end = 'End', executable = false })` returns
`{ document, ids: { definitions, process, start, end, flow } }`.

- `name` is required and non-empty after trimming; otherwise it throws a core refusal with
  code `invalid-name`. It becomes the process name verbatim.
- `start` and `end` are the names of the start and end events; their ids are minted from
  them. `executable` lands on the process as `isExecutable`.
- Ids are minted with `mintId` from `patch.mjs` against an initially empty id set, with the
  hints `Definitions_<name>`, `Process_<name>`, the start name, the end name, and
  `Flow_<startId>`, in that order. The diagram and plane use `Diagram_<name>` and
  `Plane_<name>`. Whatever `mintId` does to spaces and accents is the rule; the unit test pins
  it with an accented, spaced name and asserts XSD validity. If `mintId` cannot produce an
  NCName, the fix belongs in `mintId`, not in `seed`.
- The tree is built with `moddle.create`, `$parent` set on every element the way `patch.mjs`
  does, the flow linked with `linkFlow(flow, start, end)`, and the definitions given
  `targetNamespace` `http://bpmn.io/schema/bpmn`.
- The plane's `bpmnElement` is the process. DI comes from `placeNew(document, [start, end,
  flow])`; the result must place all three, or `seed` throws `di-incomplete`.
- The function is deterministic: same input, same XML after `serialize`.

Serialization is the caller's job (`serialize(document)`), so the CLI and the MCP server share
one seed and one place to serialize.

### `backend/io/bpmn-file.mjs::createBpmn`

`createBpmn(path, xml, { root })` writes a file that must not exist yet.

1. `confine(root, path)` as already implemented in this module: an absent leaf is confined by
   its real parent, which must be a directory inside the root.
2. The extension must be `.bpmn`; otherwise `THB_NOT_BPMN`.
3. `open(target, 'wx')`. `EEXIST` becomes `THB_EXISTS` with the message
   `"<basename>" already exists — edit it with bpmn_patch or the op tools, or pick another
   path`. No temporary file and no rename: there is no previous content to protect, and `wx`
   is the primitive that cannot overwrite.
4. Write, `sync`, close, read back, `parse`. On any failure after the open, unlink the target
   and rethrow. The function returns `{ path, rev }` with `rev` from `revOf` over the bytes
   that landed.

Directories are never created. A missing parent is `THB_NOT_FOUND` naming the parent; the
agent can create it with its own tools and retry.

### Allowance in the core

`LEVELS = ['safe', 'additive', 'routing', 'destructive']` and `allowanceOf(value)` move from
`backend/cli/apply.mjs` to `backend/core/ops.mjs`, next to `risk`. `allowanceOf` keeps its
contract: comma-separated, trimmed, default `safe,additive`, unknown level throws with code
`usage` naming the level and the list. The CLI imports it from the core; its tests move with
it. This is the second caller, which is what justifies the move.

### `backend/mcp/server.mjs` (the therblig server)

`createServer(root, { allowance = allowanceOf(process.env.TREADLE_ALLOW) } = {})`.

**`bpmn_create`**

```json
{ "path": "processos/pedido.bpmn", "name": "Pedido",
  "start": "Pedido recebido", "end": "Pedido concluído", "executable": false }
```

Returns `{ ok: true, path, base_rev, ids: { process, start, end, flow } }`. Annotations:
`readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`. The description says
the file must not exist and that the result is a connected start → end process to grow with
the op tools. Creation is not subject to the allowance: it changes nothing that exists.

**Ten op tools.** One tool per entry of `OPS` in `tools.mjs`, named in snake_case after the op:
`bpmn_insert_after`, `bpmn_branch`, `bpmn_parallel`, `bpmn_timeout`, `bpmn_on_error`,
`bpmn_bypass`, `bpmn_guard`, `bpmn_rename`, `bpmn_move_to_lane`, `bpmn_message`. Each is
registered in a loop with an exact input schema built by `fromJsonSchema` from

```json
{ "path": "string", "args": ARGS[op], "dry_run": "boolean, default true",
  "base_rev": "string, required when dry_run is false" }
```

Exact per-op schemas are not optional: Studio F15 recorded an agent guessing `target`, `node`
and `id` for `bypass` when the schema was generic.

Shared handler, in order:

1. `confine(root, path)` and `readWithRev` — `THB_NOT_FOUND`, `THB_OUTSIDE_ROOT`,
   `THB_NOT_BPMN` as today.
2. `parse`, `project`, then `OPS[op](ir, args)`. A core refusal (`element-not-found`,
   `anchor-no-outgoing`, `anchor-ambiguous`, `target-outside-container`, …) is returned as
   `THB_OP_REFUSED` with the core code in `reason` and the core message, which already names
   the remedy.
3. `propose(document, envelope.plan)`.
4. Dry run (default): `{ ok: result.ok, dry_run: true, base_rev, op, risk, explain, plan,
   inverse, minted, gates, diff }`. `ok` is false when a gate failed, and the gates say which.
5. Write (`dry_run: false`): `base_rev` missing → `THB_REV_REQUIRED`; different from the bytes
   on disk → `THB_STALE_REV` naming the current rev; any gate failed → `THB_GATE_FAILED` with the
   gates (`THB_GATE_FAILED`); `risk` not in the allowance → `THB_REQUIRES_APPROVAL` with `risk`, the allowance and
   the sentence `publishing a <risk> edit needs a human — this server allows <list>`. Otherwise
   `writeBpmnAtomic(path, result.xml, { root })` and the dry-run payload plus
   `{ written: true, new_rev }`.

Annotations on every op tool: `readOnlyHint: false`, `destructiveHint: true` (a write renames
over the original; the client decides whether to ask), `idempotentHint: false`.

**`bpmn_patch`** gains the same allowance check before its write, using `risk(ops)` from the
core over the primitives it was given. `del` is `destructive` and is refused under the default
allowance with `THB_REQUIRES_APPROVAL`; previews are never refused. Nothing else about the tool
changes.

**`tools/list` order** is fixed: the five existing tools in their current order, then
`bpmn_create`, then the ten op tools alphabetically. Sixteen tools. The smoke test asserts the
list and its order.

### `backend/mcp/bin.mjs`

`--allow <list>` overrides `TREADLE_ALLOW`, which overrides the default `safe,additive`. The
value goes through `allowanceOf`; an unknown level exits with the usage message on stderr. The
`--help` text documents both, and the stderr banner prints the allowance next to the root:
`therblig-mcp: serving <root>, allowing safe,additive`.

### Plugin

`plugin/plugins/therblig/.mcp.json` becomes

```json
{
  "mcpServers": {
    "therblig": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/../../../backend/mcp/bin.mjs",
               "--root", "${CLAUDE_PROJECT_DIR}"],
      "env": { "TREADLE_ALLOW": "${TREADLE_ALLOW:-safe,additive,routing}" }
    }
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` is `plugin/plugins/therblig` inside the checkout, because a local
marketplace loads in place; three levels up is the repository root. The plugin's allowance
default is wider than the server's (`routing` included) by the user's decision: an agent that
cannot add a gateway cannot build a process. A user narrows it by exporting `TREADLE_ALLOW`.

`plugin/README.md` documents two ways to load the plugin from the checkout:

```
/plugin marketplace add /absolute/path/to/treadle/plugin
/plugin install therblig@therblig
```

or, for a single session, `claude --plugin-dir /absolute/path/to/treadle/plugin/plugins/therblig`.
It also states the one change at publication: the `command`/`args` pair goes back to
`npx -y -p therblig therblig-mcp --root ${CLAUDE_PROJECT_DIR}`.

Client-side permission is documented, not shipped: a project that wants a prompt before every
write adds `mcp__therblig__bpmn_patch`, `mcp__therblig__bpmn_create` and the op tools to
`permissions.ask` in its `.claude/settings.json`.

### Skill

`skills/bpmn-editing/SKILL.md` gains, in this order:

- **Creating a process.** `bpmn_create` first; then grow the file with the op tools, anchored on
  the ids the creation returned. Do not write the XML yourself.
- **Label what you add.** `bpmn_branch` needs `label` for its conditional exit or the lint gate
  refuses the write; `name` labels the gateway. Every step gets a `name`.
- **When to preview.** An inherited file: dry run, read the gates and the diff, then write. A
  file created in this session: write directly; the gates still run.
- **When the server says a human is needed.** `THB_REQUIRES_APPROVAL` is not retryable. Report
  the edit, its risk and the allowance to the user and stop.
- The operation table maps intents to the new tool names; the `bpmn_patch` primitives remain
  for what the ops do not cover.

## Data flow: one agent session

```
bpmn_create      { path, name }                                  → { base_rev: r0, ids }
bpmn_insert_after{ path, args: { anchor: ids.start, step: {type:"user", name:"Conferir"} },
                   dry_run: false, base_rev: r0 }                → { written, new_rev: r1 }
bpmn_branch      { path, args: { anchor: "Conferir", when: "aprovado", yes: [...], no: [...],
                   name: "Aprovado?", label: "sim" }, dry_run: false, base_rev: r1 } → r2
bpmn_timeout     { path, args: { on: "Conferir", after: "P2D", to: ids.end, name: "Atrasou" },
                   dry_run: false, base_rev: r2 }                → r3
bpmn_lint        { path }                                        → 0 errors
```

Each write returns the rev the next call needs. If Camunda Modeler saves in between, the next
write is `THB_STALE_REV` and the agent re-reads.

## Error handling

Every refusal is a tool execution error (`isError: true`) carrying a JSON body from
`TherbligError.toResult()`: `{ ok: false, code, error, ...detail }`. New codes:

| code | when | detail carried |
|---|---|---|
| `THB_EXISTS` | `bpmn_create` on an existing path | the basename |
| `THB_REQUIRES_APPROVAL` | write whose risk is above the allowance | `risk`, `allowance` |
| `THB_OP_REFUSED` | the op itself refused before any plan existed | `reason` (core code) |

Existing codes keep their meaning. No stack trace and no document content ever reach the
client. A failed `createBpmn` leaves no file behind; a failed op write leaves the original
bytes untouched, because the guard and the gates run before `writeBpmnAtomic` renames.

## Testing

- **Unit, `backend/test/unit/seed.test.mjs`.** Determinism; ids; `linkFlow` wiring visible as
  `incoming`/`outgoing`; `diCoverage` 3 of 3; all five gates green on the serialized seed; empty
  name refused with `invalid-name`; a name with spaces and accents yields an XSD-valid file;
  `executable: true` lands on the process.
- **Unit, allowance.** The existing `allowanceOf` tests move to the core and keep passing.
- **Integration, next to the existing `bpmn-file` tests.** `createBpmn` writes and returns a
  rev matching `revOf`; refuses an existing file with `THB_EXISTS` and leaves it byte-identical;
  refuses a path outside the root, a `.xml` name, and a missing parent; on a parse-back failure
  the target is gone afterwards.
- **Smoke, `backend/test/smoke/mcp.test.mjs`, therblig section, spawning `bin.mjs`.**
  `tools/list` returns the sixteen names in the fixed order; the full flow create → insert_after
  → branch (with label) → timeout → lint with zero errors on a temporary workspace; `branch`
  without `label` refused with the lint gate in the body; stale `base_rev` refused; `routing`
  refused under the default allowance and written under `--allow safe,additive,routing`;
  `bpmn_patch` with `del` refused without `destructive` and written with it; `bpmn_create` on an
  existing file refused; every stdout line is JSON-RPC.
- **Contracts.** `backend/contracts` consumes `seed` and `allowanceOf` from the emitted
  `.d.mts`, so `npm run types` proves the public surface.
- **Architecture test.** Unchanged and still required: the core never mentions
  `@modelcontextprotocol`.
- **Gate.** `make check` green with core and io at 100%.

## Documentation

- **ADR, new:** creation is a seed plus the same operations. Nothing but the two-node seed is
  ever generated from nothing; growth goes through ops with gates, inverse and risk. Rests on
  the evidence above and on ADR-003 and F4.
- **ADR-010 rev. 2, amended:** the named operations arrive on the path-addressed server; the
  handle server keeps them for its existing callers until those migrate.
- **Finding, new:** the reproducer of the 2-node seed to a 10-node process, with the two
  refusals that shaped the design, and the command lines.
- **`docs/DEFERRED.md`:** pools and lanes from scratch (trigger: the first request for a new
  multi-pool process); retiring `treadle-mcp` and the second io stack (trigger: the Studio and
  the bench no longer call it).
- **`README.md`:** registration from the checkout and the allowance.

## Runtime verification

1. `make check`.
2. A scratch project outside the checkout, e.g. `/tmp/scratch-bpmn` with a `processos/`
   directory. In Claude Code there: `/plugin marketplace add <checkout>/plugin`,
   `/plugin install therblig@therblig`, then the prompt "crie um processo de pedido com
   conferência, cobrança e um prazo de dois dias". Expected: the file exists, `bpmn_lint`
   reports zero errors, and the transcript shows only therblig tools writing it.
3. `node backend/cli/main.mjs lint /tmp/scratch-bpmn/processos/pedido.bpmn --root /tmp/scratch-bpmn`
   green, and `make dev WORKSPACE=/tmp/scratch-bpmn` lists the file, renders the diagram and
   shows all gates passing.
4. The same session asks for a step to be removed: the server answers
   `THB_REQUIRES_APPROVAL`, the agent stops and reports, the file is unchanged.

The finding records the transcript's tool calls and the resulting file's line count and gate
output.

## Non-goals

- Publishing to npm or moving the plugin to its own repository.
- Unifying `therblig-mcp` and `treadle-mcp`, or `backend/io/paths.mjs` and
  `backend/io/bpmn-file.mjs`.
- Creating pools, lanes, collaborations or data artifacts from scratch.
- Studio UI tests, the bake-off, Windows CI validation, geometric undo.
- Creating directories on the agent's behalf.
- A `treadle new` CLI command. Creation is reached through the MCP tool and the core function;
  the CLI is verified through `lint` on the file the agent created.

## Risks and open points

- `${CLAUDE_PROJECT_DIR}` may be unset when Claude Code is launched outside a project; the
  server then roots at its cwd, and `resolveRoot` already refuses a filesystem root and the home
  directory.
- The plugin's default allowance includes `routing`. A gateway added by mistake is reversible
  through the op's inverse or `git checkout`; the finding records that the choice was
  deliberate.
- Two MCP servers with two addressing models stay in the tree until the deferred retirement.
- Windows: the relative `../../..` in `.mcp.json` is resolved by Node; the CI matrix on
  `windows-latest` runs the smoke suite that spawns `bin.mjs`.

## Acceptance

- Sixteen tools on `therblig-mcp`, in a fixed order, with exact per-op schemas.
- A new file created by `bpmn_create` passes all five gates and has DI for every element.
- The full agent flow in the smoke test writes a process with a gateway, a timer and an error
  handler, and `bpmn_lint` reports zero errors.
- No write happens above the allowance, on a stale rev, on a failed gate, or over an existing
  file at creation.
- The plugin loads from the checkout by path, with no npm publication.
- `make check` green; core and io at 100%; `git diff --check` clean.

## Implementation notes

Recorded after the build on 2026-09-23. The plan is
`docs/superpowers/plans/2026-09-23-local-agent-integration.md`.

- A failed gate on a write is `THB_GATE_FAILED`, not `THB_REFUSED`: the latter's recovery text
  speaks of collateral change, which is a different refusal. `THB_OP_REFUSED` carries the core
  code in `reason`; `TherbligError` grew an `extra` bag for that and for `gates`, `risk` and
  `allowance`.
- `seed` builds its nodes and flow through `applyPatch` rather than `moddle.create`, because the
  architecture test allows a BPMN node type string only inside `blocks/`. It does not throw
  `di-incomplete`: the branch would be unreachable and the unit test pins `diCoverage` at 3 of 3.
- `mintId` now prefixes an id that would start with a digit with `_`, the root cause behind
  `start: "1º contato"` producing an invalid NCName.
- The differential lint gate also demands a `name` on the gateway `branch` mints, not only a
  `label` on its conditional exit; the skill and the smoke test say both.
- `risk` accepts the file API's `move` (routing) and `message` (additive) so `bpmn_patch` can be
  judged by the same allowance.
- In permission rules, a plugin-installed server is `mcp__plugin_therblig_therblig__<tool>`, not
  `mcp__therblig__<tool>`; the plugin README shows the plugin form.
- The real run: Claude Code 2.1.280 with `--plugin-dir` from the checkout created
  `processos/pedido.bpmn` in six therblig calls (create, insert_after, branch, timeout,
  on_error, lint), 127 lines, 9 nodes, `bpmn_lint` 0 errors, 13 turns, US$0.82. One attempt to
  `Write` the XML directly was denied by the tool allowlist and the agent switched to
  `bpmn_create`.
