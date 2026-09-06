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
import { containerOf, walk } from './document.mjs';
import { block } from './registry.mjs';
import Linter from 'bpmnlint/lib/linter.js';
import NodeResolver from 'bpmnlint/lib/resolver/node-resolver.js';
import * as xmllint from 'xmllint-wasm';

// Resolved against this module, not the working directory: a CLI is run from the user's
// project, never from ours.
const OMG_DIR = new URL('../../third_party/omg/', import.meta.url);
const SCHEMA_FILES = ['BPMN20.xsd', 'Semantic.xsd', 'BPMNDI.xsd', 'DI.xsd', 'DC.xsd'];

let preload = null;
function schemas() {
  if (!preload) {
    preload = SCHEMA_FILES.map((f) => ({
      fileName: f,
      contents: readFileSync(new URL(f, OMG_DIR), 'utf8'),
    }));
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
      schema: [readFileSync(new URL('BPMN20.xsd', OMG_DIR), 'utf8')],
      preload: schemas(),
    });
    return { ok: res.valid, errors: res.errors.slice(0, 10).map((e) => e.message) };
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

// Gate 6. XSD validity is not reference integrity and must never be reported as if it were.
// Measured against these seven broken documents: every one is XSD-valid and passes
// bpmnlint:correctness, and none of them is caught by anything else. A duplicate id is the one
// case the XSD's ID type does catch, so it is deliberately not a rule here.
//
// moddle drops a reference it cannot resolve rather than keeping the raw name, so a dangling
// reference reaches us as an absent one — which is why "required and missing" is the same finding
// as "points at nothing".
const BOUNDARY = block('boundary').bpmn;
const REQUIRED_REFS = {
  'bpmn:SequenceFlow': ['sourceRef', 'targetRef'],
  'bpmn:MessageFlow': ['sourceRef', 'targetRef'],
  [BOUNDARY]: ['attachedToRef'],
  'bpmndi:BPMNShape': ['bpmnElement'],
  'bpmndi:BPMNEdge': ['bpmnElement'],
};

const referenceKey = (finding) => JSON.stringify(finding);

export async function references(xml) {
  const { rootElement } = await new BpmnModdle().fromXML(xml);
  const findings = [];

  for (const el of walk(rootElement)) {
    if (!el.id || !el.$type) continue;

    for (const attr of REQUIRED_REFS[el.$type] ?? []) {
      if (!el[attr]) findings.push({ rule: 'unresolved-reference', id: el.id, attr });
    }

    // Only a message flow may cross a container; a sequence flow may not, and neither may the
    // attachment of a boundary event to its host.
    if (el.$type === 'bpmn:SequenceFlow' && el.sourceRef && el.targetRef) {
      const from = containerOf(el.sourceRef);
      const to = containerOf(el.targetRef);
      if (from !== to || from !== containerOf(el)) {
        findings.push({ rule: 'flow-crosses-container', id: el.id, from, to });
      }
    }
    if (el.$type === BOUNDARY && el.attachedToRef) {
      const host = containerOf(el.attachedToRef);
      if (host !== containerOf(el)) {
        findings.push({ rule: 'boundary-outside-host', id: el.id, host });
      }
    }
    if (el.$type === 'bpmn:Lane') {
      const scope = containerOf(el);
      for (const node of el.flowNodeRef ?? []) {
        if (containerOf(node) !== scope) {
          findings.push({ rule: 'lane-outside-process', id: el.id, node: node.id });
        }
      }
    }
    // A default flow that does not leave the element routes nothing.
    if (el.default && !(el.outgoing ?? []).includes(el.default)) {
      findings.push({ rule: 'default-not-outgoing', id: el.id, flow: el.default.id });
    }
  }

  return { ok: findings.length === 0, findings };
}

// Structural fingerprint used by gate 4. Order-independent so serialization
// differences never register as collateral damage.
export async function fingerprint(xml) {
  const { rootElement } = await new BpmnModdle().fromXML(xml);
  const els = [];
  for (const el of walk(rootElement)) {
    if (!el.$type || !el.id) continue;
    if (/^(bpmndi|dc|di):/.test(el.$type)) continue;
    const rec = { id: el.id, type: el.$type, name: el.name ?? null };
    if (el.sourceRef) rec.src = el.sourceRef.id;
    if (el.targetRef) rec.tgt = el.targetRef.id;
    if (el.attachedToRef) rec.host = el.attachedToRef.id;
    if (el.default) rec.default = el.default.id;
    els.push(rec);
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
    ok: rigid,                               // true = made room; false = reflowed
    rigid,
    reflowed: !rigid,
  };
}

// Measured 2026-09-01 against the 21 MIWG reference models: bpmnlint:correctness
// passes 22/22, bpmnlint:recommended passes 0/12 of the non-trivial ones. So
// correctness is a hard gate and recommended is only meaningful DIFFERENTIALLY —
// did this edit introduce style errors that were not already there?
export async function scoreAll(beforeXml, afterXml, opts = {}) {
  const g1 = await parses(afterXml);
  if (!g1.ok) return { gates: { parses: g1 }, passed: 0, of: 6 };
  const hasDI = /BPMNShape/.test(afterXml);
  const [g2, hard, styleAfter, styleBefore, g4] = await Promise.all([
    xsdValid(afterXml),
    lintClean(afterXml, { hasDI, config: { extends: 'bpmnlint:correctness' } }),
    lintClean(afterXml, { hasDI, config: { extends: 'bpmnlint:recommended' } }),
    lintClean(beforeXml, { hasDI: /BPMNShape/.test(beforeXml), config: { extends: 'bpmnlint:recommended' } }),
    noCollateral(beforeXml, afterXml, opts),
  ]);
  const introduced = styleAfter.errors.length - styleBefore.errors.length;
  const g3 = { ok: hard.ok && introduced <= 0, correctness: hard, styleDelta: introduced, styleErrors: styleAfter.errors.length };
  const g5 = diffSanity(beforeXml, afterXml);
  // Differential, for the same reason bpmnlint:recommended is (ADR-006): an inherited file may
  // carry findings of its own — C.7.0 ships a BPMNEdge with no bpmnElement — and blocking every
  // edit to it would punish the edit for the input's pre-existing state. The question is whether
  // THIS edit broke a reference.
  const [refsBefore, refsAfter] = await Promise.all([references(beforeXml), references(afterXml)]);
  const known = new Set(refsBefore.findings.map(referenceKey));
  const brokenHere = refsAfter.findings.filter((finding) => !known.has(referenceKey(finding)));
  const g6 = { ok: brokenHere.length === 0, introduced: brokenHere, findings: refsAfter.findings };
  const gates = { parses: g1, xsdValid: g2, references: g6, lintClean: g3, noCollateral: g4, diffSanity: g5 };
  const passed = [g1, g2, g3, g4, g5, g6].filter((gate) => gate.ok).length;
  return { gates, passed, of: 6 };
}
