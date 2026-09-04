// Four defects in the arm-C prototype, each confirmed by reading the code and
// reproduced here. Every check ASSERTS THE CORRECT BEHAVIOUR, so this file is RED
// today and goes green when M1 lands its four fixes. That ordering is the point:
// a probe written after the fix proves nothing about the bug it claims to cover.
//
//   D1  set {targetRef}   — the `set` fallthrough (ir.mjs:232) assigns any key
//                           verbatim, so an id STRING lands where moddle expects an
//                           element REFERENCE and serializes as targetRef="undefined".
//                           F8 already says no code path may set sourceRef/targetRef
//                           directly; nothing enforces it.
//   D2  set {documentation} — same fallthrough, but bpmn:Documentation is a typed
//                           child collection, so a bare string throws on serialize.
//   D3  del orphans DI    — `del` removes semantics and never touches the plane, so
//                           the BPMNShape survives pointing at a deleted element, and
//                           diCoverage only checks elements->DI so it reports 100%.
//   D4  placeNew(container) — `del` adds the CONTAINER id to `changed` (ir.mjs:260),
//                           so the obvious placeNew([...changed, ...created]) mints a
//                           <BPMNShape bpmnElement="Payment"> for the Process itself.
import { parse, serialize, applyPatch, index } from '../arms/ir.mjs';
import { placeNew, diCoverage } from '../arms/place.mjs';
import { readFileSync } from 'node:fs';

const FIXTURE = 'bench/corpus/handmade/zeebe-roundtrip.bpmn';
const src = readFileSync(FIXTURE, 'utf8');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n         ${e.message}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }

console.log('D1 — a raw adjacency write must not be accepted (F8)');
await check('set {targetRef} is rejected, or at minimum never serializes "undefined"', async () => {
  const doc = await parse(src);
  let threw = null;
  try { applyPatch(doc, [{ op: 'set', id: 'Flow_2', patch: { targetRef: 'End_1' } }]); }
  catch (e) { threw = e; }
  if (threw) return;                                   // rejected: correct
  const xml = await serialize(doc);
  assert(!/targetRef="undefined"/.test(xml),
    'accepted the op and serialized targetRef="undefined" — silent graph corruption');
});

console.log('\nD2 — a typed child must not be writable as a bare string');
await check('set {documentation} does not throw on serialize', async () => {
  const doc = await parse(src);
  let threw = null;
  try { applyPatch(doc, [{ op: 'set', id: 'Charge', patch: { documentation: 'why we charge' } }]); }
  catch (e) { threw = e; }
  if (threw) return;                                   // rejected up front: correct
  await serialize(doc);                                // must not throw
});

console.log('\nD3 — deleting an element must delete its DI');
await check('del leaves no BPMNShape pointing at a removed element', async () => {
  const doc = await parse(src);
  applyPatch(doc, [{ op: 'del', id: 'Review' }]);
  const live = index(doc.definitions);
  const orphans = [];
  const seen = new Set();
  (function walk(el) {
    if (!el || typeof el !== 'object' || seen.has(el)) return;
    seen.add(el);
    if ((el.$type === 'bpmndi:BPMNShape' || el.$type === 'bpmndi:BPMNEdge') && el.bpmnElement) {
      const t = el.bpmnElement;
      const id = typeof t === 'string' ? t : t.id;
      if (id && !live.has(id)) orphans.push(`${el.$type} -> ${id}`);
    }
    for (const k of Object.keys(el)) {
      if (k === '$parent' || k === '$model' || k === '$descriptor') continue;
      const v = el[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  })(doc.definitions);
  assert(orphans.length === 0, `${orphans.length} orphaned DI element(s): ${orphans.join(', ')}`);
});

await check('diCoverage notices the orphan (DI->elements, not just elements->DI)', async () => {
  const doc = await parse(src);
  applyPatch(doc, [{ op: 'del', id: 'Review' }]);
  const cov = diCoverage(doc.definitions);
  assert(!cov.ok, 'diCoverage reported 100% coverage over a document containing orphaned DI');
});

console.log('\nD4 — placement must never mint a shape for a container');
await check('the documented del->place flow does not give the Process a BPMNShape', async () => {
  const doc = await parse(src);
  const { changed, created } = applyPatch(doc, [{ op: 'del', id: 'Review' }]);
  placeNew(doc, [...changed, ...created]);             // exactly what a caller would write
  const xml = await serialize(doc);
  const shaped = [...xml.matchAll(/<bpmndi:BPMNShape[^>]*bpmnElement="([^"]+)"/g)].map(m => m[1]);
  assert(!shaped.includes('Payment'),
    `minted a BPMNShape for the bpmn:Process "Payment" (shapes: ${shaped.join(', ')})`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('RED as designed — these are the M1 fixes. Green means M1 landed.');
process.exit(fail ? 1 : 0);
