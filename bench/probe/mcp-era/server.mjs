// Minimal Treadle-shaped stdio server, to answer one question: which protocol era do
// real MCP clients open with, and does the v2 SDK's default legacy:'serve' carry the
// 2025-era ones? Kill criterion 2 depends on the answer.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

await serveStdio((ctx) => {
  // Everything diagnostic goes to stderr: stdout is the JSON-RPC stream, and one
  // stray console.log corrupts it. This is why M2 has a stdout-purity CI job.
  process.stderr.write(`[era-probe] factory invoked, ctx keys: ${Object.keys(ctx || {}).join(',') || '(none)'}\n`);
  const server = new McpServer({ name: 'treadle-era-probe', version: '0.0.0' });
  server.registerTool(
    'bpmn_read',
    { description: 'Stand-in for the real tool.', inputSchema: z.object({ path: z.string() }) },
    async ({ path }) => ({ content: [{ type: 'text', text: `would read ${path}` }] }),
  );
  return server;
});
process.stderr.write('[era-probe] serveStdio returned; listening\n');
