// F9, re-measured with an instrument that can see labels.
//
// F9 is the project's headline preservation claim: "making room is a RIGID
// TRANSLATION — every shape that moved moved by the same delta — whereas a relayout
// scatters them into many deltas", and gate 5 tests distinctDeltas <= 1.
//
// Gate 5 cannot see the failure it most needs to see. boundsList() (gates.mjs:114)
// is a lazy regex — /<BPMNShape[^>]*bpmnElement="([^"]+)"[\s\S]*?<Bounds[^>]*x=.../ —
// so it captures the FIRST <Bounds> after each shape's opening tag. In BPMN DI the
// shape's own dc:Bounds always comes first and the <bpmndi:BPMNLabel><dc:Bounds> after
// it, so the label bounds are never captured by construction. Meanwhile place.mjs's
// make-room loop (place.mjs:107-110) translates di.bounds.x and nothing else.
//
// Net: when placement makes room, every affected label stays where it was while its
// shape slides out from under it, and gate 5 reports rigid: true.
//
// This probe measures the same four files F9 published, off the moddle tree rather
// than off a regex, and reports labelsDetached. RED until M1's translateShape lands.
import { parse, applyPatch, project } from '../arms/ir.mjs';
import { placeNew } from '../arms/place.mjs';
import { readFileSync } from 'node:fs';

// F9's own four cases, selected exactly as place-selftest.mjs selects them so the
// numbers are directly comparable to the published table.
const CASES = [
  ['handmade/zeebe-roundtrip.bpmn', 'Payment', 'Charge', 'Review'],
  ['miwg/C.9.1.bpmn', null, null, null],
  ['miwg/C.9.0.bpmn', null, null, null],
  ['miwg/A.1.0.bpmn', null, null, null],
];

function* walk(el, seen = new Set()) {
  if (!el || typeof el !== 'object' || seen.has(el)) return;
  seen.add(el); yield el;
  for (const k of Object.keys(el)) {
    if (k === '$parent' || k === '$model' || k === '$descriptor') continue;
    const v = el[k];
    if (Array.isArray(v)) for (const c of v) yield* walk(c, seen);
    else if (v && typeof v === 'object') yield* walk(v, seen);
  }
}

// Shape bounds AND label bounds, keyed by element id. The pair is the point.
function snapshot(definitions) {
  const m = new Map();
  for (const el of walk(definitions)) {
    if (el.$type !== 'bpmndi:BPMNShape' || !el.bpmnElement?.id || !el.bounds) continue;
    const lb = el.label?.bounds;
    m.set(el.bpmnElement.id, {
      shape: { x: el.bounds.x, y: el.bounds.y },
      label: lb ? { x: lb.x, y: lb.y } : null,
    });
  }
  return m;
}

const d = (a, b) => `${b.x - a.x},${b.y - a.y}`;
const ZERO = '0,0';

let anyDetached = 0;
const table = [];

for (const [file, proc, a, b] of CASES) {
  const doc = await parse(readFileSync(`bench/corpus/${file}`, 'utf8'));
  const before = snapshot(doc.definitions);

  const ir = project(doc.definitions);
  let src = a, tgt = b, container = proc;
  if (!src) {
    const nodeIds = new Map(ir.nodes.map(n => [n.id, n]));
    const flow = (ir.flows || []).find(f =>
      nodeIds.get(f.from)?.type?.match(/task|user|service|manual|send|receive/) && nodeIds.get(f.to));
    if (!flow) { console.log(`${file}: no suitable insertion point — skipped`); continue; }
    src = flow.from; tgt = flow.to; container = nodeIds.get(flow.from).in;
  }

  const { created } = applyPatch(doc, [
    { op: 'add', type: 'user', name: 'Inserted step', in: container, id: 'TreadleInserted', between: [src, tgt] },
  ]);
  placeNew(doc, ['TreadleInserted', ...created]);
  const after = snapshot(doc.definitions);

  // Only pre-existing shapes: a newly minted shape has no "before" to preserve.
  let moved = 0, total = 0, detached = 0;
  const deltas = new Set();
  const victims = [];
  for (const [id, was] of before) {
    const now = after.get(id);
    if (!now) continue;
    total++;
    const sd = d(was.shape, now.shape);
    if (sd === ZERO) continue;
    moved++; deltas.add(sd);
    // A label that exists must travel with its shape. No label is not a failure.
    if (was.label && now.label) {
      const ld = d(was.label, now.label);
      if (ld !== sd) { detached++; victims.push(id); }
    } else if (was.label && !now.label) { detached++; victims.push(id + '(label lost)'); }
  }
  anyDetached += detached;
  table.push({
    file: file.replace('miwg/', '').replace('handmade/', ''),
    moved, total, deltas: deltas.size,
    rigid: deltas.size <= 1, detached, victims: victims.slice(0, 4),
  });
}

console.log('F9 re-measured, with labels\n');
console.log('file'.padEnd(22), 'shapes moved'.padEnd(14), 'deltas'.padEnd(7), 'gate5 says'.padEnd(11), 'labels detached');
for (const r of table) {
  console.log(
    r.file.padEnd(22),
    `${r.moved} / ${r.total}`.padEnd(14),
    String(r.deltas).padEnd(7),
    (r.rigid ? 'rigid ✓' : 'reflowed').padEnd(11),
    `${r.detached}${r.victims.length ? '  (' + r.victims.join(', ') + ')' : ''}`,
  );
}

console.log(`\n${anyDetached} label(s) left behind across the four files F9 published as clean.`);
console.log('gate 5 called every one of these a rigid translation, because boundsList()');
console.log('never reads a BPMNLabel and the make-room loop never moves one.');
console.log(`\nverdict: ${anyDetached === 0 ? 'LABELS TRAVEL WITH THEIR SHAPES' : 'F9 SUPERSEDED — expected RED until M1 translateShape lands'}`);
process.exit(anyDetached === 0 ? 0 : 1);
