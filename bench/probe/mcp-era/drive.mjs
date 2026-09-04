// Sends a scripted opening to server.mjs over stdio and prints what comes back.
// Two eras, two runs: the 2025 `initialize` handshake, and a 2026-07-28 opening that
// carries protocolVersion in _meta with no handshake at all.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// new URL(...).pathname yields /C:/... on Windows, which spawns as C:C:...
const SERVER = fileURLToPath(new URL('server.mjs', import.meta.url));

const ERAS = {
  '2025 (initialize handshake)': [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'era-probe', version: '0.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ],
  '2026-07-28 (no handshake, _meta claims)': [
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {} } } },
  ],
};

for (const [label, msgs] of Object.entries(ERAS)) {
  console.log(`\n=== ${label} ===`);
  const p = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  for (const m of msgs) { p.stdin.write(JSON.stringify(m) + '\n'); await new Promise(r => setTimeout(r, 250)); }
  await new Promise(r => setTimeout(r, 900));
  p.kill();
  await new Promise(r => setTimeout(r, 150));

  for (const line of out.split('\n').filter(Boolean)) {
    let o; try { o = JSON.parse(line); } catch { console.log('  NON-JSON ON STDOUT:', line.slice(0, 120)); continue; }
    const tools = o.result?.tools?.map(t => t.name).join(',');
    console.log('  <-', JSON.stringify({
      id: o.id,
      resultType: o.result?.resultType,
      protocolVersion: o.result?.protocolVersion,
      serverInfo: o.result?.serverInfo?.name,
      tools,
      error: o.error?.message,
    }).slice(0, 220));
  }
  if (!out.trim()) console.log('  (no stdout)');
  if (err.trim()) console.log('  stderr:', err.trim().split('\n').join(' | ').slice(0, 220));
}
