#!/usr/bin/env node
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createStore } from './store.mjs';
import { toolsFor } from './tools.mjs';

// The risk levels this server may publish without a human. Everything above is proposed in full
// and refused at publish: the refusal is about writing, not about looking.
const AUTONOMOUS = new Set((process.env.TREADLE_ALLOW ?? 'safe,additive').split(','));

export function build({ root = process.cwd(), autonomous = AUTONOMOUS } = {}) {
  const store = createStore({ root });
  const server = new McpServer(
    { name: 'treadle', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  for (const tool of toolsFor({ store, root, autonomous })) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: fromJsonSchema(tool.inputSchema) },
      async (input) => {
        try {
          const result = await tool.handler(input);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (error) {
          // Never a stack, never document content: the model gets the rule and the remedy.
          const code = error.code ?? 'error';
          const text = error.message.startsWith(`${code}:`) ? error.message : `${code}: ${error.message}`;
          return { content: [{ type: 'text', text }], isError: true };
        }
      },
    );
  }

  return server;
}

// stdout belongs to the protocol; anything we have to say goes to stderr.
serveStdio(() => build(), { onerror: (error) => process.stderr.write(`${error.message}\n`) });
