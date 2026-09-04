// The oracle has to be right about real files before it is allowed to refuse a write.
//
// Two properties under test:
//   1. inspect() is calibrated — its diagnostics over the corpus match a committed
//      baseline exactly. Not "zero diagnostics": the MIWG models genuinely do carry
//      unlabelled gateway branches and multi-start pools, and a validator tuned until
//      real reference files come back clean is a validator tuned to say nothing.
//   2. compare() catches the specific damage this project has already shipped once —
//      a detached label (F11), an orphaned shape (F12/D3), silent content loss — and
//      stays quiet on an edit that only does what it said it would.
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse, serialize } from '../../packages/therblig/src/model.mjs';
import { applyPatch } from '../../packages/therblig/src/patch.mjs';
import { placeNew } from '../../packages/therblig/src/place.mjs';
import { project } from '../../packages/therblig/src/ir.mjs';
import { inspect } from './inspect.mjs';
import { compare, blocking } from './compare.mjs';
import { message } from './invariants.mjs';

const BASELINE = 'bench/oracle/baseline.json';
let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n         ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

function corpus(dir = 'bench/corpus') {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...corpus(p));
    else if (e.endsWith('.bpmn')) out.push(p);
  }
  return out.sort();
}

// --- 1. inspect() against a frozen baseline ---------------------------------
console.log('inspect — calibration against the corpus');

const observed = {};
for (const f of corpus()) {
  const d = await inspect(readFileSync(f, 'utf8'));
  const rel = f.split(/[\\/]/).slice(2).join('/');
  const counts = {};
  for (const x of d) counts[x.code] = (counts[x.code] ?? 0) + 1;
  if (Object.keys(counts).length) observed[rel] = counts;
}

if (process.argv.includes('--update') || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, JSON.stringify(observed, null, 2) + '\n');
  console.log(`  baseline written (${Object.keys(observed).length} files with findings)`);
} else {
  const expected = JSON.parse(readFileSync(BASELINE, 'utf8'));
  await check('corpus diagnostics match the committed baseline', async () => {
    const a = JSON.stringify(expected, null, 1), b = JSON.stringify(observed, null, 1);
    assert(a === b, `baseline drift.\n  expected ${a}\n  observed ${b}\n  Re-run with --update only if the change is intended.`);
  });
}

await check('a clean file is clean', async () => {
  const d = await inspect(readFileSync('bench/corpus/handmade/zeebe-roundtrip.bpmn', 'utf8'));
  assert(d.length === 0, `expected 0 diagnostics, got: ${d.map((x) => x.code).join(', ')}`);
});

await check('every message reads as what · rule · fix', async () => {
  const d = await inspect(readFileSync('bench/corpus/miwg/B.2.0.bpmn', 'utf8'));
  assert(d.length > 0, 'fixture produced nothing to check');
  for (const x of d) {
    const m = message(x);
    assert(m.split('. ').length >= 3, `not three parts: "${m}"`);
    assert(/[.!?]$/.test(m.trim()), `no terminal period: "${m}"`);
    assert(!/!/.test(m), `exclamation mark in "${m}"`);
  }
});

// --- 2. compare() on an honest edit -----------------------------------------
console.log('\ncompare — an edit that only does what it said');

const FIXTURE = 'bench/corpus/miwg/C.9.0.bpmn';
const src = readFileSync(FIXTURE, 'utf8');

async function insertStep(xml) {
  const doc = await parse(xml);
  const ir = project(doc.definitions);
  const nodes = new Map(ir.nodes.map((n) => [n.id, n]));
  const flow = (ir.flows || []).find((f) => nodes.get(f.from)?.type?.match(/task|user|service/) && nodes.get(f.to));
  const { changed, created } = applyPatch(doc, [
    { op: 'add', type: 'user', name: 'Review score', in: nodes.get(flow.from).in, id: 'OracleTmp', between: [flow.from, flow.to] },
  ]);
  placeNew(doc, ['OracleTmp', ...created]);
  return { xml: await serialize(doc), touched: ['OracleTmp', ...changed, ...created] };
}

const honest = await insertStep(src);

await check('reports nothing blocking when the edit is declared', async () => {
  const d = await compare(src, honest.xml, { expectedIds: honest.touched });
  const bad = blocking(d);
  assert(bad.length === 0, `blocked an honest edit: ${bad.map((x) => message(x)).join(' | ')}`);
});

await check('the same edit, undeclared, is caught as unexpected change', async () => {
  const d = await compare(src, honest.xml, { expectedIds: [] });
  assert(blocking(d).length > 0, 'an undeclared structural edit passed the guard');
});

console.log('\ncompare — the damage this project has already shipped once');

await check('catches a detached label (F11)', async () => {
  const doc = await parse(honest.xml);
  // Move one shape and deliberately leave its label behind.
  for (const el of (function* w(e, s = new Set()) {
    if (!e || typeof e !== 'object' || s.has(e)) return; s.add(e); yield e;
    for (const k of Object.keys(e)) { if (k.startsWith('$')) continue; const v = e[k];
      if (Array.isArray(v)) for (const c of v) yield* w(c, s); else if (v && typeof v === 'object') yield* w(v, s); }
  })(doc.definitions)) {
    if (el.$type === 'bpmndi:BPMNShape' && el.bounds && el.label?.bounds) { el.bounds.x += 40; break; }
  }
  const d = await compare(honest.xml, await serialize(doc), { expectedIds: [] });
  assert(d.some((x) => x.code === 'LABEL_DETACHED'), `not caught: ${d.map((x) => x.code).join(', ')}`);
});

await check('catches silently lost content', async () => {
  const doc = await parse(src);
  const proc = doc.definitions.rootElements.find((r) => r.$type === 'bpmn:Process' && r.flowElements?.length);
  proc.flowElements.pop();
  const d = await compare(src, await serialize(doc), { expectedIds: [] });
  assert(d.some((x) => x.code === 'CONTENT_LOST'), `not caught: ${d.map((x) => x.code).join(', ')}`);
});

await check('catches a lost XML comment (F10)', async () => {
  // Inserted after the XML declaration rather than before a named element: the corpus
  // spans nine exporters and C.9.0 uses the `bpmn2:` prefix, so anchoring on `<bpmn:process`
  // made this a no-op that tested nothing. The assertion below guards against that.
  const withComment = src.replace(/(<\?xml[^>]*\?>)/, '$1\n<!-- reviewed by legal 2026-03 -->');
  assert(withComment !== src, 'fixture unchanged — the comment was never inserted');
  const d = await compare(withComment, src, { expectedIds: [] });
  assert(d.some((x) => x.code === 'COMMENT_LOST'), `not caught: ${d.map((x) => x.code).join(', ')}`);
});

await check('a file compared with itself is silent', async () => {
  const d = await compare(src, src, { expectedIds: [] });
  assert(d.length === 0, `noise on an identity comparison: ${d.map((x) => x.code).join(', ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
