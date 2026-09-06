import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { createStore } from '../../backend/mcp/store.mjs';
import { toolsFor } from '../../backend/mcp/tools.mjs';

// Arm C is served by the production MCP handlers, not by an imitation of them: the same
// createStore and toolsFor that `treadle-mcp` runs. Only the transport differs — in-process here,
// stdio there — so a number this bench produces is a number about the shipped server.

// The handlers describe themselves in JSON Schema; the Agent SDK wants a Zod raw shape. This
// converts the small vocabulary the tools actually use, and refuses anything else rather than
// silently degrading a schema — the schema is what gives the model its accuracy.
function zodFor(schema) {
  switch (schema.type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(schema.items ? zodFor(schema.items) : z.unknown());
    case 'object':
      return schema.properties
        ? z.object(
            Object.fromEntries(
              Object.entries(schema.properties).map(([key, value]) => [key, zodFor(value)]),
            ),
          )
        : z.record(z.string(), z.unknown());
    default:
      throw new Error(`No Zod equivalent for schema type "${schema.type}"`);
  }
}

function shapeFor({ properties, required = [] }) {
  return Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => {
      const built = zodFor(schema).describe(schema.description ?? '');
      return [name, required.includes(name) ? built : built.optional()];
    }),
  );
}

export function treadleServer({ root, autonomous }) {
  const store = createStore({ root });
  const tools = toolsFor({ store, root, autonomous }).map((definition) =>
    tool(
      definition.name,
      definition.description,
      shapeFor(definition.inputSchema),
      async (args) => {
        try {
          return {
            content: [{ type: 'text', text: JSON.stringify(await definition.handler(args)) }],
          };
        } catch (error) {
          const code = error.code ?? 'error';
          const text = error.message.startsWith(`${code}:`)
            ? error.message
            : `${code}: ${error.message}`;
          return { content: [{ type: 'text', text }], isError: true };
        }
      },
    ),
  );

  return createSdkMcpServer({ name: 'treadle', version: '0.0.0', tools });
}
