# therblig — Claude Code plugin

A marketplace of one. Installs the therblig MCP server and a skill that teaches an agent
what BPMN's structure makes unsafe about ordinary text editing.

```
/plugin marketplace add EduardoHOS/therblig-plugin
/plugin install therblig@therblig
```

The server is fetched with `npx -y therblig-mcp` and confined to `${CLAUDE_PROJECT_DIR}`.
Nothing is uploaded anywhere: it reads and writes local files and makes no network calls.

## What is in here

```
.claude-plugin/marketplace.json      the marketplace manifest
plugins/therblig/
  .claude-plugin/plugin.json         the plugin manifest
  .mcp.json                          launches therblig-mcp, rooted at the project
  skills/bpmn-editing/SKILL.md       what a model cannot infer from the tool schemas
```

## Publishing this

These files live in the main repository while therblig is unpublished. They move to a
separate public repo — `EduardoHOS/therblig-plugin` — when the npm packages ship, because
`/plugin marketplace add` takes a repository and the main repo carries a 23-file BPMN
corpus nobody installing a plugin wants to clone.

The skill is the part worth reading. It is not a restatement of the tool descriptions —
it is the four things that have actually caused bugs here: adjacency stored twice, layout
that fails silently on 41% of the OMG's own reference models, the one-time reformat, and
the comment loss that comes with it.
