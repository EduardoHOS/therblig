// The MCP server, driven over a real stdio pipe.
//
// Not a unit test of the handlers: the things most likely to break are the seams —
// the protocol envelope, stdout purity, and path confinement — and none of those exist
// until a process is actually spawned. The traversal cases were written before the
// handler that defends against them.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = fileURLToPath(new URL('../../mcp/bin.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../bench/corpus', import.meta.url));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); fail++; }
};

// The 2026-07-28 envelope. protocolVersion alone is refused with -32602: the revision
// requires clientCapabilities beside it, and the SDK enforces that before dispatch.
const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function session(messages, { root = ROOT } = {}) {
  const p = spawn(process.execPath, [BIN, '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 10000);
    p.stderr.on('data', (d) => { if (String(d).includes('serving')) { clearTimeout(t); resolve(); } });
  });
  for (const m of messages) {
    p.stdin.write(JSON.stringify(m) + '\n');
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 700));
  p.kill();
  await new Promise((r) => setTimeout(r, 150));
  const lines = out.split('\n').filter(Boolean);
  return { lines, err, replies: lines.map((l) => { try { return JSON.parse(l); } catch { return { __raw: l }; } }) };
}

const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, _meta: META } });
const payload = (r) => { try { return JSON.parse(r.result.content[0].text); } catch { return null; } };

console.log('protocol');

const listed = await session([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }]);
const tools = listed.replies[0]?.result?.tools ?? [];
check('tools/list returns the five tools', tools.length === 5, `got ${tools.map((t) => t.name).join(', ') || 'nothing'}`);
check('every tool is named bpmn_*', tools.every((t) => t.name.startsWith('bpmn_')), tools.map((t) => t.name).join(', '));
// SEP-2567 requires tools/list not to vary per connection. Two separate sessions, not
// one array compared with a copy of itself — which is what this asserted before, and
// which is true of every array.
const listedAgain = await session([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }]);
check('the tool list does not vary between connections',
  JSON.stringify(tools.map((t) => t.name)) ===
    JSON.stringify((listedAgain.replies[0]?.result?.tools ?? []).map((t) => t.name)),
  JSON.stringify((listedAgain.replies[0]?.result?.tools ?? []).map((t) => t.name)));

check('stdout is JSON-RPC and nothing else', listed.lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }),
  listed.lines.find((l) => { try { JSON.parse(l); return false; } catch { return true; } }));
check('diagnostics go to stderr', listed.err.includes('serving'));

console.log('\ntools answer');

const s = await session([
  call(1, 'bpmn_read', { path: 'miwg/C.9.1.bpmn', view: 'outline' }),
  call(2, 'bpmn_explain', { path: 'miwg/C.9.1.bpmn' }),
  call(3, 'bpmn_lint', { path: 'miwg/A.2.0.bpmn' }),
  call(4, 'bpmn_verify', { path: 'miwg/C.9.1.bpmn' }),
]);
const [read, expl, lint, ver] = s.replies.map(payload);
check('bpmn_read returns a projection and a revision', read?.ok && read.nodes?.length > 0 && /^[0-9a-f]{12}$/.test(read.base_rev), JSON.stringify(read)?.slice(0, 120));
check('bpmn_explain returns counts and mermaid', expl?.summary?.tasks === 4 && expl.mermaid?.startsWith('flowchart'), expl?.headline);
check('bpmn_lint reports the known warnings', lint?.warnings === 3 && lint.errors === 0, JSON.stringify(lint?.diagnostics?.[0])?.slice(0, 120));
check('bpmn_verify confirms the schemas', ver?.ok === true && ver.xsd_valid === true, JSON.stringify(ver)?.slice(0, 120));
check('the same read twice gives the same revision', read?.base_rev === expl?.base_rev);

console.log('\npath confinement');

// A temp file OUTSIDE the root, with a legal extension, that really exists — so the
// only thing that can refuse it is the containment check.
const outside = mkdtempSync(join(tmpdir(), 'therblig-'));
const escapee = join(outside, 'escape.bpmn');
writeFileSync(escapee, '<?xml version="1.0"?><definitions/>');

const t = await session([
  call(1, 'bpmn_read', { path: '../../package.json' }),
  call(2, 'bpmn_read', { path: escapee }),
  call(3, 'bpmn_read', { path: '../../../../../../Windows/System32/drivers/etc/hosts' }),
  call(4, 'bpmn_read', { path: 'miwg/does-not-exist.bpmn' }),
  call(5, 'bpmn_read', { path: '.' }),
]);
const codes = t.replies.map((r) => payload(r)?.code);
check('a non-bpmn extension is refused', codes[0] === 'THB_NOT_BPMN', String(codes[0]));
check('an absolute path outside the root is refused', codes[1] === 'THB_OUTSIDE_ROOT', String(codes[1]));
check('traversal out of the root is refused', codes[2] === 'THB_NOT_BPMN' || codes[2] === 'THB_OUTSIDE_ROOT', String(codes[2]));
check('a missing file says so', codes[3] === 'THB_NOT_FOUND', String(codes[3]));
check('the root itself is not readable as a file', codes[4] === 'THB_NOT_BPMN', String(codes[4]));
check('every refusal is a tool error, not a protocol error', t.replies.every((r) => r.result?.isError === true && !r.error),
  JSON.stringify(t.replies.find((r) => r.error))?.slice(0, 140));
rmSync(outside, { recursive: true, force: true });

console.log('\npatch previews, never writes');

const before = (await session([call(1, 'bpmn_read', { path: 'handmade/zeebe-roundtrip.bpmn' })])).replies.map(payload)[0];
const patched = await session([
  call(1, 'bpmn_patch', {
    path: 'handmade/zeebe-roundtrip.bpmn', dry_run: true,
    ops: [{ op: 'add', type: 'user', name: 'Review score', in: 'Payment', id: 'McpTmp', between: ['Charge', 'Review'] }],
  }),
  call(2, 'bpmn_patch', { path: 'handmade/zeebe-roundtrip.bpmn', dry_run: true, base_rev: 'deadbeefcafe', ops: [{ op: 'set', id: 'Charge', patch: { name: 'x' } }] }),
  call(3, 'bpmn_read', { path: 'handmade/zeebe-roundtrip.bpmn' }),
]);
const [p1, p2, p3] = patched.replies.map(payload);
check('a clean edit previews without refusing', p1?.ok === true && p1.written === false && p1.created.length > 0, JSON.stringify(p1?.diagnostics)?.slice(0, 140));
check('a stale base_rev is refused', p2?.code === 'THB_STALE_REV', String(p2?.code));
check('the file on disk is untouched', p3?.base_rev === before?.base_rev, `${before?.base_rev} -> ${p3?.base_rev}`);

console.log('\nwriting, over the wire');

// A sandbox root so the corpus is never the thing being written to.
const sandboxRoot = mkdtempSync(join(tmpdir(), 'therblig-mcp-'));
const target = join(sandboxRoot, 'orders.bpmn');
writeFileSync(target, readFileSync(join(ROOT, 'handmade', 'zeebe-roundtrip.bpmn')));
const originalBytes = readFileSync(target);

const w = await session([
  call(1, 'bpmn_read', { path: 'orders.bpmn', view: 'outline' }),
], { root: sandboxRoot });
const rev = payload(w.replies[0])?.base_rev;
check('the sandbox file reads', /^[0-9a-f]{12}$/.test(rev ?? ''), String(rev));

// The refusals run in their OWN session, so the bytes can be inspected before any
// accepted write happens. Bundling them with the successful write made the "wrote
// nothing" assertion vacuous — it could not distinguish a refusal from a write that
// was later overwritten.
const refusals = await session([
  call(1, 'bpmn_patch', { path: 'orders.bpmn', dry_run: false, ops: [{ op: 'set', id: 'Charge', patch: { name: 'A' } }] }),
  call(2, 'bpmn_patch', { path: 'orders.bpmn', dry_run: false, base_rev: 'deadbeefcafe', ops: [{ op: 'set', id: 'Charge', patch: { name: 'B' } }] }),
], { root: sandboxRoot });
const [noRev, badRev] = refusals.replies.map(payload);
check('a write with no base_rev is refused', noRev?.code === 'THB_REV_REQUIRED', String(noRev?.code));
check('a write with a stale base_rev is refused', badRev?.code === 'THB_STALE_REV', String(badRev?.code));
check('neither refusal touched the file',
  Buffer.compare(originalBytes, readFileSync(target)) === 0, 'the bytes changed after two refused writes');

const w2 = await session([
  call(1, 'bpmn_patch', { path: 'orders.bpmn', dry_run: false, base_rev: rev, ops: [{ op: 'set', id: 'Charge', patch: { name: 'Charge the card' } }] }),
  call(2, 'bpmn_read', { path: 'orders.bpmn', view: 'outline' }),
], { root: sandboxRoot });
const [wrote, reread] = w2.replies.map(payload);
check('a write with the right base_rev lands', wrote?.written === true && wrote.new_rev && wrote.new_rev !== rev,
  JSON.stringify(wrote)?.slice(0, 160));
check('the revision moves after a write', reread?.base_rev === wrote?.new_rev, `${reread?.base_rev} vs ${wrote?.new_rev}`);
check('the edit is really on disk', readFileSync(target, 'utf8').includes('Charge the card'));

rmSync(sandboxRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
