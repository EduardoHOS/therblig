// Does incremental placement actually produce a renderable diagram, on real files,
// without disturbing what was already laid out?
import { parse, serialize, applyPatch, project } from './ir.mjs';
import { placeNew, diCoverage } from './place.mjs';
import { scoreAll } from '../scorer/gates.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
};

// Files that already have complete DI and a straightforward main flow.
const CASES = [
  ['handmade/zeebe-roundtrip.bpmn', 'Payment', 'Charge', 'Review'],
  ['miwg/C.9.1.bpmn', null, null, null],
  ['miwg/C.9.0.bpmn', null, null, null],
  ['miwg/A.1.0.bpmn', null, null, null],
];

for (const [file, proc, a, b] of CASES) {
  console.log(`\n${file}`);
  const original = readFileSync(`bench/corpus/${file}`, 'utf8');
  const doc = await parse(original);
  const before = await serialize(doc);

  const cov0 = diCoverage(doc.definitions);
  check('starts with complete DI', cov0.ok, `${cov0.covered}/${cov0.need} missing ${JSON.stringify(cov0.missing.slice(0, 3))}`);

  // Pick an insertion point: use the given one, or the first flow between two tasks.
  const ir = project(doc.definitions);
  let src = a, tgt = b, container = proc;
  if (!src) {
    const nodeIds = new Map(ir.nodes.map((n) => [n.id, n]));
    const flow = (ir.flows || []).find((f) => nodeIds.get(f.from)?.type?.match(/task|user|service|manual|send|receive/) && nodeIds.get(f.to));
    if (!flow) { console.log('  (no suitable insertion point — skipped)'); continue; }
    src = flow.from; tgt = flow.to; container = nodeIds.get(flow.from).in;
  }

  const { created } = applyPatch(doc, [
    { op: 'add', type: 'user', name: 'Inserted step', in: container, id: 'TherbligInserted', between: [src, tgt] },
  ]);
  const touched = ['TherbligInserted', ...created];
  const { placed, movedShapes } = placeNew(doc, touched);
  const after = await serialize(doc);

  const cov = diCoverage(doc.definitions);
  check('DI complete after insert', cov.ok, `${cov.covered}/${cov.need} missing ${JSON.stringify(cov.missing.slice(0, 3))}`);
  check('placed the new node and its flow', placed.length >= 2, `placed ${JSON.stringify(placed)}`);

  const r = await scoreAll(before, after, { expectChangedIds: [...touched, src] });
  check('xsd-valid', r.gates.xsdValid.ok, JSON.stringify(r.gates.xsdValid.errors?.slice(0, 1)));
  check('correctness-clean', r.gates.lintClean.correctness.ok, JSON.stringify(r.gates.lintClean.correctness.errors?.slice(0, 2)));
  check('introduced no new style errors', r.gates.lintClean.styleDelta <= 0, `delta ${r.gates.lintClean.styleDelta}`);
  console.log(`       diff -${r.gates.diffSanity.removedLines} +${r.gates.diffSanity.addedLines} | shapes moved ${r.gates.diffSanity.shapesMoved}/${r.gates.diffSanity.shapesTotal} (placement shifted ${movedShapes})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
