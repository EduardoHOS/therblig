#!/usr/bin/env node
// therblig MCP server, stdio.
//
// stdout carries JSON-RPC and nothing else. Every diagnostic goes to stderr — which is
// also the migration path the 2026-07-28 spec names for the deprecated Logging feature,
// so it is where a server is now supposed to talk anyway. A single stray console.log in
// this package corrupts the stream, which is what the stdout-purity CI job checks.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { resolveRoot } from '../paths.mjs';
import { createServer } from './server.mjs';

const argv = process.argv.slice(2);
const valueOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

if (argv.includes('--help')) {
  process.stderr.write(
    'therblig-mcp — BPMN 2.0 over MCP, stdio.\n\n' +
    '  --root <dir>   directory the server may read (default: cwd)\n\n' +
    'Register with Claude Code:\n' +
    '  claude mcp add therblig -- npx -y therblig-mcp --root .\n');
  process.exit(0);
}

const root = await resolveRoot(valueOf('--root') ?? process.cwd());
process.stderr.write(`therblig-mcp: serving ${root}\n`);

// legacy: 'serve' is the default and is what carries 2025-era clients. Measured
// 2026-09-04 (F14): one factory answers both a 2025 initialize handshake and a
// 2026-07-28 opening that has no handshake at all, with no branching here.
await serveStdio(() => createServer(root), {
  onerror: (e) => process.stderr.write(`therblig-mcp: ${e.message}\n`),
});
