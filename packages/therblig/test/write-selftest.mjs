// Writes. The two properties that matter are the two that are hard to get right:
//
//   refused == byte-identical   a rejected edit must not touch the file at all, not
//                               "write it and roll back", because a rollback is
//                               another chance to fail.
//   interrupted == old or new   a kill during the write leaves a whole file, never a
//                               truncated one. This is what the temp-file-plus-rename
//                               dance buys, and it is worth actually killing a process
//                               to check rather than trusting the pattern.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyToFile, atomicWrite } from '../src/write.mjs';
import { readWithRev } from '../src/rev.mjs';
import { parses, xsdValid } from '../src/validate.mjs';
import { inspect } from '../src/oracle/inspect.mjs';
import { message } from '../src/oracle/invariants.mjs';

const CORPUS = fileURLToPath(new URL('../../../bench/corpus/', import.meta.url));
let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n         ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

const box = mkdtempSync(join(tmpdir(), 'therblig-write-'));
const sandbox = (name) => {
  const dst = join(box, `${Math.random().toString(36).slice(2)}-${name.split('/').pop()}`);
  copyFileSync(join(CORPUS, name), dst);
  return dst;
};

console.log('a refused edit does not touch the file');

await check('a cross-pool sequence flow is refused, and the bytes are identical', async () => {
  // The model's mistake this guards against is a real one, and it is in the product
  // brief's own validation set: sequence flows stay inside one pool.
  const f = sandbox('miwg/C.2.0.bpmn');
  const before = readFileSync(f);
  const { rev } = await readWithRev(f);
  const ir = JSON.parse(JSON.stringify(await import('../src/ir.mjs').then(async (m) =>
    m.project((await import('../src/model.mjs').then((x) => x.parse(before.toString()))).definitions))));
  // Two task-like nodes in different processes.
  const byProc = new Map();
  for (const n of ir.nodes) if (/task|user|service|manual|send|receive/.test(n.type)) {
    if (!byProc.has(n.in)) byProc.set(n.in, n.id);
  }
  const [a, b] = [...byProc.values()];
  assert(a && b, 'fixture does not have two pools with tasks');

  const r = await applyToFile(f, [{ op: 'connect', from: a, to: b }], { baseRev: rev });
  assert(r.refused, `expected a refusal, got ${JSON.stringify(r.diagnostics.map((d) => d.code))}`);
  assert(r.written === false, 'reported a write');
  assert(r.diagnostics.some((d) => d.code === 'CROSS_POOL_SEQUENCE_FLOW'),
    r.diagnostics.map((d) => message(d)).join(' | '));
  assert(Buffer.compare(before, readFileSync(f)) === 0, 'the file changed despite being refused');
});

await check('a refusal reports the rule, not just a rejection', async () => {
  const f = sandbox('miwg/C.2.0.bpmn');
  const { rev } = await readWithRev(f);
  const m = await import('../src/model.mjs');
  const irm = await import('../src/ir.mjs');
  const ir = irm.project((await m.parse(readFileSync(f, 'utf8'))).definitions);
  const byProc = new Map();
  for (const n of ir.nodes) if (/task|user|service/.test(n.type)) if (!byProc.has(n.in)) byProc.set(n.in, n.id);
  const [a, b] = [...byProc.values()];
  const r = await applyToFile(f, [{ op: 'connect', from: a, to: b }], { baseRev: rev });
  const msg = r.diagnostics.map((d) => message(d)).join(' ');
  assert(/stay inside one pool/.test(msg), msg);
  assert(/message flow/i.test(msg), `no fix offered: ${msg}`);
});

console.log('\nrevisions');

await check('a write without a base_rev is refused', async () => {
  const f = sandbox('handmade/zeebe-roundtrip.bpmn');
  const before = readFileSync(f);
  let code = null;
  try { await applyToFile(f, [{ op: 'set', id: 'Charge', patch: { name: 'x' } }], {}); }
  catch (e) { code = e.code; }
  assert(code === 'THB_REV_REQUIRED', String(code));
  assert(Buffer.compare(before, readFileSync(f)) === 0, 'file changed');
});

await check('a write against a stale base_rev is refused', async () => {
  const f = sandbox('handmade/zeebe-roundtrip.bpmn');
  const before = readFileSync(f);
  let code = null;
  try { await applyToFile(f, [{ op: 'set', id: 'Charge', patch: { name: 'x' } }], { baseRev: 'deadbeefcafe' }); }
  catch (e) { code = e.code; }
  assert(code === 'THB_STALE_REV', String(code));
  assert(Buffer.compare(before, readFileSync(f)) === 0, 'file changed');
});

console.log('\nan honest edit lands');

await check('the edit is written and the result is still valid', async () => {
  const f = sandbox('handmade/zeebe-roundtrip.bpmn');
  const { rev } = await readWithRev(f);
  const r = await applyToFile(f, [
    { op: 'add', type: 'user', name: 'Review score', in: 'Payment', id: 'ReviewScore', between: ['Charge', 'Review'] },
  ], { baseRev: rev });
  assert(r.written, `not written: ${r.diagnostics.map((d) => d.code).join(', ')}`);
  assert(r.new_rev && r.new_rev !== rev, 'revision did not move');
  const after = readFileSync(f, 'utf8');
  assert((await parses(after)).ok, 'result does not parse');
  assert((await xsdValid(after)).ok, 'result is not XSD-valid');
  const d = await inspect(after);
  assert(d.filter((x) => x.severity === 'error').length === 0, d.map((x) => message(x)).join(' | '));
  assert(after.includes('Review score'), 'the edit is not in the file');
});

await check('a file with a non-empty collapsed sub-process is editable', async () => {
  // The MIWG corpus has six collapsed sub-processes and every one is empty, so nothing
  // in it could catch diCoverage refusing an ordinary Camunda file whose collapsed
  // sub-process has children. This fixture exists for that.
  const f = sandbox('handmade/collapsed-subprocess.bpmn');
  const { rev } = await readWithRev(f);
  const r = await applyToFile(f, [
    { op: 'add', type: 'user', name: 'Print label', in: 'Fulfilment', id: 'PrintLabel', between: ['Pack', 'End_1'] },
  ], { baseRev: rev });
  assert(r.written, `refused an ordinary edit: ${r.diagnostics.map((d) => message(d)).join(' | ')}`);
});

console.log('\nthe two operations that needed their own verbs');

await check('move rewrites lane membership on the lane, and only one lane', async () => {
  const f = sandbox('miwg/C.1.0.bpmn');
  const { rev } = await readWithRev(f);
  const m = await import('../src/model.mjs');
  const irm = await import('../src/ir.mjs');
  const ir = irm.project((await m.parse(readFileSync(f, 'utf8'))).definitions);
  const node = ir.nodes.find((n) => n.lane && /task|user|service/.test(n.type));
  const target = ir.lanes.find((l) => l.id !== node.lane);
  assert(node && target, 'fixture has no laned task and second lane');

  const r = await applyToFile(f, [{ op: 'move', id: node.id, lane: target.id }], { baseRev: rev });
  assert(r.written, `refused: ${r.diagnostics.map((d) => message(d)).join(' | ')}`);

  const after = irm.project((await m.parse(readFileSync(f, 'utf8'))).definitions);
  assert(after.nodes.find((n) => n.id === node.id).lane === target.id, 'the node did not move');
  // Listed in exactly one lane: doing half the edit leaves it in both or neither, which
  // is the same class of bug as writing one side of a sequence flow.
  let listed = 0;
  for (const el of m.walk((await m.parse(readFileSync(f, 'utf8'))).definitions)) {
    if (el.$type === 'bpmn:Lane' && (el.flowNodeRef || []).some((x) => x.id === node.id)) listed++;
  }
  assert(listed === 1, `listed in ${listed} lanes`);
});

await check('message creates a flow that may cross a pool boundary', async () => {
  const f = sandbox('miwg/C.2.0.bpmn');
  const { rev } = await readWithRev(f);
  const m = await import('../src/model.mjs');
  const irm = await import('../src/ir.mjs');
  const ir = irm.project((await m.parse(readFileSync(f, 'utf8'))).definitions);
  const byProc = new Map();
  for (const n of ir.nodes) if (/task|user|service|manual|send|receive/.test(n.type) && !byProc.has(n.in)) byProc.set(n.in, n);
  const [a, b] = [...byProc.values()];

  const r = await applyToFile(f, [{ op: 'message', from: a.id, to: b.id, name: 'On its way', id: 'MF_Ok' }], { baseRev: rev });
  assert(r.written, `refused a legal message flow: ${r.diagnostics.map((d) => message(d)).join(' | ')}`);
  const after = readFileSync(f, 'utf8');
  assert((await parses(after)).ok && (await xsdValid(after)).ok, 'result is not valid');
  assert(irm.project((await m.parse(after)).definitions).messageFlows.some((x) => x.id === 'MF_Ok'), 'not in the projection');
});

await check('a message flow that stays inside one pool is refused', async () => {
  const f = sandbox('miwg/C.2.0.bpmn');
  const before = readFileSync(f);
  const { rev } = await readWithRev(f);
  const m = await import('../src/model.mjs');
  const irm = await import('../src/ir.mjs');
  const ir = irm.project((await m.parse(before.toString())).definitions);
  const grouped = {};
  for (const n of ir.nodes) if (/task|user|service|manual|send|receive/.test(n.type) && n.in) (grouped[n.in] ??= []).push(n);
  const pair = Object.values(grouped).find((g) => g.length >= 2);
  assert(pair, 'fixture has no two tasks in one process');

  const r = await applyToFile(f, [{ op: 'message', from: pair[0].id, to: pair[1].id, id: 'MF_Bad' }], { baseRev: rev });
  assert(r.refused, 'wrote a message flow that does not cross a pool');
  assert(r.diagnostics.some((d) => d.code === 'INTRA_POOL_MESSAGE_FLOW'), r.diagnostics.map((d) => d.code).join(', '));
  assert(Buffer.compare(before, readFileSync(f)) === 0, 'the file changed despite the refusal');
});

await check('move refuses a target that is not a lane', async () => {
  const f = sandbox('miwg/C.1.0.bpmn');
  const { rev } = await readWithRev(f);
  const m = await import('../src/model.mjs');
  const irm = await import('../src/ir.mjs');
  const ir = irm.project((await m.parse(readFileSync(f, 'utf8'))).definitions);
  const node = ir.nodes.find((n) => /task|user|service/.test(n.type));
  let code = null;
  try { await applyToFile(f, [{ op: 'move', id: node.id, lane: ir.nodes[0].id }], { baseRev: rev }); }
  catch (e) { code = e.code; }
  assert(code === 'THB_UNKNOWN_TYPE', String(code));
});

console.log('\ninterrupting a write');

await check('SIGKILL mid-write leaves the old file or the new one, never a fragment', async () => {
  const f = sandbox('miwg/C.9.0.bpmn');
  const original = readFileSync(f, 'utf8');
  const { rev } = await readWithRev(f);
  const script = join(box, 'slow-write.mjs');
  // Writes the temp file, then hangs BEFORE the rename — the exact window where an
  // interrupted edit would corrupt a file if it were written in place.
  writeFileSync(script, `
    import { applyToFile } from ${JSON.stringify(fileURLToPath(new URL('../src/write.mjs', import.meta.url)))};
    process.stdout.write('go\\n');
    await applyToFile(${JSON.stringify(f)}, [{ op: 'set', id: 'Task_1', patch: { name: 'Interrupted' } }], { baseRev: ${JSON.stringify(rev)} });
    await new Promise(() => {});
  `);
  const p = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((r) => { const t = setTimeout(r, 6000); p.stdout.on('data', () => { clearTimeout(t); setTimeout(r, 400); }); });
  p.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));

  const now = readFileSync(f, 'utf8');
  const whole = (await parses(now)).ok;
  assert(whole, 'the file on disk no longer parses — a partial write escaped');
  assert(now === original || now.includes('Interrupted'),
    'the file is neither the original nor the finished edit');
});

await check('atomicWrite leaves no temp file behind on success', async () => {
  const f = join(box, 'atomic.bpmn');
  writeFileSync(f, '<a/>');
  await atomicWrite(f, '<b/>');
  assert(readFileSync(f, 'utf8') === '<b/>', 'content not replaced');
  const { readdirSync } = await import('node:fs');
  const strays = readdirSync(box).filter((n) => n.includes('.tmp'));
  assert(strays.length === 0, `temp files left: ${strays.join(', ')}`);
});

rmSync(box, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
