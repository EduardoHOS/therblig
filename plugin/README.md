# therblig — Claude Code plugin

A marketplace of one. Installs the therblig MCP server and a skill that teaches an agent
what BPMN's structure makes unsafe about ordinary text editing — and how to create a
process from nothing without writing XML.

## From this checkout, unpublished

The plugin runs the server in place from the repository it lives in, so nothing is
installed from npm. In Claude Code, from the project whose `.bpmn` files the agent may
create and edit:

```
/plugin marketplace add /absolute/path/to/treadle/plugin
/plugin install therblig@therblig
```

or, for a single session without a marketplace:

```
claude --plugin-dir /absolute/path/to/treadle/plugin/plugins/therblig
```

The server is confined to `${CLAUDE_PROJECT_DIR}`: it reads and writes `.bpmn` files
under that directory and nothing else, and it makes no network calls. Edits to the
server or the skill take effect at the next session or `/reload-plugins`.

### What the server may write on its own

`TREADLE_ALLOW` names the risk levels a write may reach without a human: `safe`
(names, documentation), `additive` (new steps, handlers, files), `routing` (gateways,
conditions, lanes), `destructive` (removal). The plugin sets `safe,additive,routing`, so
the agent can build a process — a process needs gateways — and cannot remove anything.
Export `TREADLE_ALLOW=safe,additive` before starting Claude Code to narrow it. A refused
write comes back as `THB_REQUIRES_APPROVAL`; the skill tells the agent to stop and ask.

To be asked before every write regardless of risk, add the write tools to
`permissions.ask` in the project's `.claude/settings.json`. A plugin's server is named
`plugin_therblig_therblig` in permission rules (a server registered by hand in `.mcp.json`
would be plain `therblig`):

```json
{ "permissions": { "ask": ["mcp__plugin_therblig_therblig__bpmn_create", "mcp__plugin_therblig_therblig__bpmn_patch", "mcp__plugin_therblig_therblig__bpmn_*"] } }
```

## What is in here

```
.claude-plugin/marketplace.json      the marketplace manifest
plugins/therblig/
  .claude-plugin/plugin.json         the plugin manifest
  .mcp.json                          launches backend/mcp/bin.mjs from the checkout, rooted at the project
  skills/bpmn-editing/SKILL.md       what a model cannot infer from the tool schemas
```

## Publishing this

At publication the `command`/`args` pair in `.mcp.json` becomes
`npx -y -p therblig therblig-mcp --root ${CLAUDE_PROJECT_DIR}` and the plugin moves to
`EduardoHOS/therblig-plugin`, because `/plugin marketplace add` takes a repository and
the main repo carries a 23-file BPMN corpus nobody installing a plugin wants to clone.
Nothing else changes.

The skill is the part worth reading. It is not a restatement of the tool descriptions —
it is the things that have actually caused bugs here: adjacency stored twice, layout
that fails silently on 41% of the OMG's own reference models, the one-time reformat, the
comment loss that comes with it, and a gateway exit that goes unlabelled.
