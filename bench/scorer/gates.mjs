// The five scoring gates, in order. Every arm of the bake-off is scored by exactly
// this code, so the comparison is apples-to-apples.
//
//   1. parses      — bpmn-moddle reads it without error
//   2. xsdValid    — validates against the five vendored OMG BPMN 2.0 schemas
//   3. lintClean   — passes bpmnlint's correctness rules
//   4. noCollateral— nothing outside the requested change was touched
//   5. diffSanity  — changed-line count, and how many dc:Bounds moved
//
// Gate 3 semantics note: bpmnlint's DI-dependent rules are unfair to semantic-only
// output, so callers pass { hasDI } and we skip those rules when DI is absent.
import { BpmnModdle } from 'bpmn-moddle';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Linter from 'bpmnlint/lib/linter.js';
import NodeResolver from 'bpmnlint/lib/resolver/node-resolver.js';
import * as xmllint from 'xmllint-wasm';

const OMG_DIR = 'third_party/omg';
const SCHEMA_FILES = ['BPMN20.xsd', 'Semantic.xsd', 'BPMNDI.xsd', 'DI.xsd', 'DC.xsd'];

let preload = null;
function schemas() {
  if (!preload) {
    preload = SCHEMA_FILES.map((f) => ({ fileName: f, contents: readFileSync(join(OMG_DIR, f), 'utf8') }));
  }
  return preload;
}

export async function parses(xml) {
  try {
    const { rootElement, warnings } = await new BpmnModdle().fromXML(xml);
    return { ok: true, warnings: warnings.length, root: rootElement };
  } catch (e) {
    return { ok: false, error: `${e.constructor.name}: ${e.message.slice(0, 200)}` };
  }
}

export async function xsdValid(xml) {
  try {
    const res = await xmllint.validateXML({
      xml: [{ fileName: 'doc.bpmn', contents: xml }],
      schema: [readFileSync(join(OMG_DIR, 'BPMN20.xsd'), 'utf8')],
      preload: schemas(),
    });
    return { ok: res.valid, errors: (res.errors || []).slice(0, 10).map((e) => (typeof e === 'string' ? e : e.message || e.rawMessage)) };
  } catch (e) {
    return { ok: false, errors: [`validator error: ${e.message.slice(0, 200)}`] };
  }
}

// bpmnlint rules that only make sense once DI exists.
const DI_RULES = new Set(['no-bpmndi', 'no-overlapping-elements']);

export async function lintClean(xml, { hasDI = true, config = { extends: 'bpmnlint:recommended' } } = {}) {
  try {
    const { rootElement } = await new BpmnModdle().fromXML(xml);
    const linter = new Linter({ resolver: new NodeResolver() });
    const report = await linter.lint(rootElement, config);
    const flat = [];
    for (const [rule, results] of Object.entries(report)) {
      if (!hasDI && DI_RULES.has(rule)) continue;
      for (const r of results) flat.push({ rule, id: r.id, category: r.category, message: r.message });
    }
    const errors = flat.filter((f) => f.category === 'error');
    return { ok: errors.length === 0, errors, warnings: flat.filter((f) => f.category !== 'error') };
  } catch (e) {
    return { ok: false, errors: [{ rule: 'linter', message: e.message.slice(0, 200) }] };
  }
}

// Structural fingerprint used by gate 4. Order-independent so serialization
// differences never register as collateral damage.
export async function fingerprint(xml) {
  const { rootElement } = await new BpmnModdle().fromXML(xml);
  const seen = new Set(), els = [];
  const stack = [rootElement];
  while (stack.length) {
    const el = stack.pop();
    if (!el || typeof el !== 'object' || seen.has(el)) continue;
    seen.add(el);
    if (el.$type && el.id && !el.$type.startsWith('bpmndi:') && !el.$type.startsWith('dc:') && !el.$type.startsWith('di:')) {
      const rec = { id: el.id, type: el.$type, name: el.name ?? null };
      if (el.sourceRef) rec.src = el.sourceRef.id ?? el.sourceRef;
      if (el.targetRef) rec.tgt = el.targetRef.id ?? el.targetRef;
      if (el.attachedToRef) rec.host = el.attachedToRef.id ?? el.attachedToRef;
      if (el.default) rec.default = el.default.id ?? el.default;
      els.push(rec);
    }
    for (const k of Object.keys(el)) {
      if (k === '$parent' || k === '$model' || k === '$descriptor') continue;
      const v = el[k];
      if (Array.isArray(v)) stack.push(...v);
      else if (v && typeof v === 'object') stack.push(v);
    }
  }
  els.sort((a, b) => a.id.localeCompare(b.id));
  return new Map(els.map((e) => [e.id, e]));
}

export async function noCollateral(beforeXml, afterXml, { expectChangedIds = [] } = {}) {
  const a = await fingerprint(beforeXml);
  const b = await fingerprint(afterXml);
  const allowed = new Set(expectChangedIds);
  const added = [...b.keys()].filter((id) => !a.has(id));
  const removed = [...a.keys()].filter((id) => !b.has(id));
  const modified = [...a.keys()].filter((id) => b.has(id) && JSON.stringify(a.get(id)) !== JSON.stringify(b.get(id)));
  const unexpected = [...added, ...removed, ...modified].filter((id) => !allowed.has(id));
  return { ok: unexpected.length === 0, added, removed, modified, unexpected };
}

export function boundsList(xml) {
  const out = [];
  const re = /<(?:\w+:)?BPMNShape[^>]*bpmnElement="([^"]+)"[\s\S]*?<(?:\w+:)?Bounds[^>]*x="([-\d.]+)"[^>]*y="([-\d.]+)"/g;
  let m;
  while ((m = re.exec(xml))) out.push([m[1], `${m[2]},${m[3]}`]);
  return new Map(out);
}

// Gate 5. The question is not "did anything move" — inserting a node into a tight
// gap has to make room — but "did the diagram get REFLOWED". Making room is a rigid
// translation: every shape that moved moved by the same delta. A relayout scrambles
// them into many different deltas. That distinction is the whole gate.
export function diffSanity(beforeXml, afterXml) {
  const A = beforeXml.split('\n'), B = afterXml.split('\n');
  const bag = new Map();
  for (const l of B) bag.set(l, (bag.get(l) || 0) + 1);
  let common = 0;
  for (const l of A) { const c = bag.get(l); if (c > 0) { common++; bag.set(l, c - 1); } }

  const before = boundsList(beforeXml), after = boundsList(afterXml);
  const deltas = new Map();
  let moved = 0;
  for (const [id, pos] of before) {
    if (!after.has(id) || after.get(id) === pos) continue;
    moved++;
    const [x0, y0] = pos.split(',').map(Number);
    const [x1, y1] = after.get(id).split(',').map(Number);
    const d = `${x1 - x0},${y1 - y0}`;
    deltas.set(d, (deltas.get(d) || 0) + 1);
  }
  const rigid = deltas.size <= 1;
  return {
    removedLines: A.length - common,
    addedLines: B.length - common,
    shapesMoved: moved,
    shapesTotal: before.size,
    distinctDeltas: deltas.size,
    rigid,                                   // true = made room; false = reflowed
    reflowed: !rigid,
  };
}

// Measured 2026-09-01 against the 21 MIWG reference models: bpmnlint:correctness
// passes 22/22, bpmnlint:recommended passes 0/12 of the non-trivial ones. So
// correctness is a hard gate and recommended is only meaningful DIFFERENTIALLY —
// did this edit introduce style errors that were not already there?
export async function scoreAll(beforeXml, afterXml, opts = {}) {
  const g1 = await parses(afterXml);
  if (!g1.ok) return { gates: { parses: g1 }, passed: 0, of: 5 };
  const hasDI = /BPMNShape/.test(afterXml);
  const [g2, hard, styleAfter, styleBefore, g4] = await Promise.all([
    xsdValid(afterXml),
    lintClean(afterXml, { hasDI, config: { extends: 'bpmnlint:correctness' } }),
    lintClean(afterXml, { hasDI, config: { extends: 'bpmnlint:recommended' } }),
    lintClean(beforeXml, { hasDI: /BPMNShape/.test(beforeXml), config: { extends: 'bpmnlint:recommended' } }),
    noCollateral(beforeXml, afterXml, opts),
  ]);
  // ADR-006, as amended. This used to be a COUNT subtraction, and because F5 measured
  // 13 of 22 corpus files already failing `recommended`, an edit that incidentally
  // cleared one pre-existing style error while introducing a `no-disconnected` scored
  // zero and passed. That mattered more than it sounds: `no-disconnected` lives only in
  // `recommended`, `correctness` has no such rule, the XSD makes the node side of
  // adjacency optional, and fingerprint() never reads incoming/outgoing — so this one
  // comparison was the only thing in the whole scorer standing between a model and a
  // violation of F8's dual-adjacency invariant.
  //
  // Now it compares multisets of `rule:elementId` identities. Any newly introduced
  // instance fails, regardless of what else the edit happened to fix.
  const identity = (e) => `${e.rule}:${e.id ?? ''}`;
  const had = new Map();
  for (const e of styleBefore.errors ?? []) had.set(identity(e), (had.get(identity(e)) ?? 0) + 1);
  const introducedList = [];
  for (const e of styleAfter.errors ?? []) {
    const k = identity(e);
    if (had.get(k)) had.set(k, had.get(k) - 1);
    else introducedList.push(k);
  }
  const introduced = introducedList.length;
  const g3 = {
    ok: hard.ok && introduced === 0,
    correctness: hard,
    styleDelta: introduced,
    introduced: introducedList,
    styleErrors: (styleAfter.errors ?? []).length,
  };
  const g5 = diffSanity(beforeXml, afterXml);
  const gates = { parses: g1, xsdValid: g2, lintClean: g3, noCollateral: g4, diffSanity: g5 };
  const passed = [g1.ok, g2.ok, g3.ok, g4.ok, g5.rigid].filter(Boolean).length;
  return { gates, passed, of: 5 };
}
