import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TREADLE_SERVER = fileURLToPath(new URL('../../mcp/server.mjs', import.meta.url));
export const THERBLIG_BIN = fileURLToPath(new URL('../../mcp/bin.mjs', import.meta.url));

// Every request in revision 2026-07-28 carries these; there is no initialize handshake.
export const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'treadle-smoke', version: '0.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/**
 * A JSON-RPC client over stdio, so a test drives the real entrypoint the way a client does.
 * @param {string} cwd
 * @param {{server?: string, args?: string[], env?: Record<string, string>}} [options]
 */
export function client(cwd, { server = TREADLE_SERVER, args = [], env = {} } = {}) {
  const child = spawn(process.execPath, [server, ...args], { cwd, env: { ...process.env, ...env } });
  const pending = new Map();
  const stdout = [];
  let stderr = '';
  let buffer = '';
  let id = 0;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      stdout.push(line);
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const send = (method, params) =>
    new Promise((resolve) => {
      const next = ++id;
      pending.set(next, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params: { _meta: META, ...params } })}\n`);
    });

  return {
    list: () => send('tools/list', {}),
    call: async (name, args) => {
      const message = await send('tools/call', { name, arguments: args });
      if (message.error) return { protocolError: message.error };
      const { content, isError } = message.result;
      const text = content[0].text;
      return { isError: isError ?? false, text, data: isError ? undefined : JSON.parse(text) };
    },
    stdout: () => stdout,
    stderr: () => stderr,
    close: () => child.kill(),
  };
}
