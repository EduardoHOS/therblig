// The receipt is a claim. These tests are about whether the claim can be checked, and
// whether checking it catches a lie — a receipt that only ever agrees with itself is
// decoration.
//
// Each tamper below alters a value that is genuinely non-zero in the honest receipt.
// An earlier draft "tampered" with two fields that were already 0, concluded the check
// worked, and proved nothing. Same failure as F15's empty sample: a test that cannot
// fail is not evidence.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse, serialize } from '../src/model.mjs';
import { project } from '../src/ir.mjs';
import { applyPatch } from '../src/patch.mjs';
import { placeNew } from '../src/place.mjs';
import { expectedFromOps } from '../src/guard.mjs';
import { buildReceipt, verifyReceipt, renderDiff } from '../src/receipt.mjs';
import { renderTree } from '../src/render/svg.mjs';

const CORPUS = fileURLToPath(new URL('../../../bench/corpus/', import.meta.url));
let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n         ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

// One real edit on a real file, used by everything below.
const beforeXml = readFileSync(CORPUS + 'miwg/C.9.0.bpmn', 'utf8');
const doc = await parse(beforeXml);
const pristine = (await parse(beforeXml)).definitions;
const ir = project(doc.definitions);
const nodes = new Map(ir.nodes.map((n) => [n.id, n]));
const anchor = ir.flows.find((f) => /task|user|service/.test(nodes.get(f.from)?.type ?? '') && nodes.get(f.to));
const ops = [{ op: 'add', type: 'user', name: 'Review score', in: nodes.get(anchor.from).in, id: 'ReceiptTmp', between: [anchor.from, anchor.to] }];
const { changed, created } = applyPatch(doc, ops);
placeNew(doc, [...new Set([...changed, ...created])]);
const afterXml = await serialize(doc);
const declared = [...expectedFromOps(ops, pristine, created)];
const receipt = await buildReceipt(beforeXml, afterXml, { file: 'C.9.0.bpmn', ops, declared, written: true });

console.log('the receipt describes the edit');

await check('it records both revisions and they differ', () => {
  assert(/^[0-9a-f]{12}$/.test(receipt.before_rev), receipt.before_rev);
  assert(/^[0-9a-f]{12}$/.test(receipt.after_rev), receipt.after_rev);
  assert(receipt.before_rev !== receipt.after_rev, 'revisions identical');
});

await check('it states the denominator, not just the numerator', () => {
  const p = receipt.diff.protectedObjects;
  assert(p.total > 0, `no protected objects counted: ${JSON.stringify(p)}`);
  assert(p.unintendedChanges === 0, `${p.unintendedChanges} unintended: ${JSON.stringify(p.offenders)}`);
  assert(/of \d+ protected objects/.test(receipt.headline), receipt.headline);
});

await check('the denominator is most of the file, not a handful', () => {
  // A guard is only as strong as what it still calls protected. When the expected set
  // was allowed to follow `in` — the containing bpmn:Process — the descendant walk put
  // the whole file in scope and this count fell from 55 to 7. Everything still passed,
  // because a guard that protects nothing never complains. Hence a floor.
  const p = receipt.diff.protectedObjects;
  assert(declared.length < 15, `${declared.length} ids declared for a one-node insert — the expected set is too broad`);
  assert(p.total > 40, `only ${p.total} protected objects on a 26-shape file; the guard has been widened until it guards nothing`);
});

await check('it measures what F9 could not see', () => {
  const L = receipt.diff.layout;
  assert(typeof L.labelsDetached === 'number', 'no labelsDetached');
  assert(L.labelsDetached === 0, `${L.labelsDetached} labels detached`);
  assert(L.rigid === true && L.distinctDeltas <= 1, JSON.stringify(L));
  assert(L.shapesMoved > 0, 'this fixture should have made room; nothing moved');
});

console.log('\nit can be checked, offline');

await check('an honest receipt re-derives from the two files', async () => {
  const v = await verifyReceipt(receipt, beforeXml, afterXml);
  assert(v.ok, JSON.stringify(v.problems));
  assert(v.checked >= 10, `only ${v.checked} claims checked`);
});

const tampers = [
  ['understated shapesMoved', (r) => { r.diff.layout.shapesMoved = 0; }],
  ['hidden detached labels', (r) => { r.diff.layout.labelsDetached = 99; }],
  ['inflated denominator', (r) => { r.diff.protectedObjects.total = 9999; }],
  ['understated unintended changes', (r) => { r.diff.protectedObjects.unintendedChanges = 7; }],
  ['a fabricated UCR', (r) => { r.diff.protectedObjects.ucr = 50; }],
  ['an invented added element', (r) => { r.diff.semantic.added.push('NotReal'); }],
];
for (const [what, mutate] of tampers) {
  await check(`it catches ${what}`, async () => {
    const t = JSON.parse(JSON.stringify(receipt));
    mutate(t);
    const v = await verifyReceipt(t, beforeXml, afterXml);
    assert(!v.ok, 'verification passed a tampered receipt');
  });
}

await check('it catches the file being swapped underneath it', async () => {
  const other = readFileSync(CORPUS + 'miwg/C.9.1.bpmn', 'utf8');
  const v = await verifyReceipt(receipt, beforeXml, other);
  assert(!v.ok && /after_rev/.test(v.problems[0]), JSON.stringify(v.problems));
});

console.log('\nthe drawing');

await check('renders BPMN notation, not a box diagram', async () => {
  const { definitions } = await parse(readFileSync(CORPUS + 'miwg/C.2.0.bpmn', 'utf8'));
  const svg = renderTree(definitions);
  assert(svg.startsWith('<svg'), 'not an svg');
  assert(/<circle/.test(svg), 'no events drawn');
  assert(/marker-end="url\(#arrow-filled\)"/.test(svg), 'sequence flows have no filled arrowhead');
  assert(/marker-end="url\(#arrow-open\)"/.test(svg), 'message flows have no open arrowhead');
  assert(/stroke-dasharray/.test(svg), 'message flows are not dashed');
  assert(/rotate\(-90/.test(svg), 'pools have no vertical name band');
});

await check('it depends on no renderer, no DOM and no browser', async () => {
  const src = readFileSync(fileURLToPath(new URL('../src/render/svg.mjs', import.meta.url)), 'utf8');
  // Imports only. The first version of this test searched the whole file and tripped on
  // the header comment that says "No bpmn-js, no diagram-js, no DOM" — it was reading
  // the promise as a violation of itself.
  const imports = [...src.matchAll(/^\s*import\s.*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  for (const banned of ['bpmn-js', 'diagram-js', 'jsdom', 'puppeteer', 'playwright']) {
    assert(!imports.some((i) => i.includes(banned)), `render/svg.mjs imports ${banned}`);
  }
  assert(!/\bdocument\.\w/.test(src), 'render/svg.mjs touches the DOM');
  assert(imports.every((i) => i.startsWith('.')), `unexpected external import: ${imports.filter((i) => !i.startsWith('.')).join(', ')}`);
});

await check('the diff picks out what changed and ghosts what moved', async () => {
  const svg = await renderDiff(beforeXml, afterXml, { title: 'test' });
  assert(/stroke-dasharray="3 3"/.test(svg), 'no ghost at a previous position');
  assert(svg.includes('#D9D3C7'), 'untouched content does not recede to rule');
  assert(svg.includes('#1C1A17'), 'changed content is not drawn in ink');
});

await check('it invents no colours outside the brand palette', async () => {
  const svg = await renderDiff(beforeXml, afterXml);
  const allowed = new Set(['#F7F4EE', '#EAE5DB', '#D9D3C7', '#6B665E', '#1C1A17', '#B5432E']);
  const used = new Set((svg.match(/#[0-9A-Fa-f]{6}/g) || []).map((c) => c.toUpperCase()));
  const stray = [...used].filter((c) => !allowed.has(c));
  assert(stray.length === 0, `off-palette colours: ${stray.join(', ')}`);
});

await check('signal is not used as decoration', async () => {
  // The brief is explicit: signal is for errors and invalid flows, never ornament.
  // A clean edit must not put it on the page at all.
  const svg = await renderDiff(beforeXml, afterXml);
  assert(!svg.includes('#B5432E'), 'signal appears on a diff with nothing wrong');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
