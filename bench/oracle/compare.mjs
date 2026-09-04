// compare(beforeXml, afterXml, {expectedIds}) -> Diagnostic[]
//
// The relational half of the oracle, and the thing that actually guards a write.
// It answers one question: did this edit change what was asked for, and nothing else?
//
// DIFFERENTIAL, not absolute. A user editing a file that already has a dangling
// messageRef must still be able to edit it — refusing would punish them for the input
// file's pre-existing sins, which is the exact mistake ADR-006 identified for lint
// presets. So a violation that was already there is not this edit's fault. Only newly
// introduced ones are reported.
import { parse, walk } from '../../packages/therblig/src/model.mjs';
import { inspectTree } from './inspect.mjs';
import { diag } from './invariants.mjs';

// DI coordinates are exporter doubles; an exact +151 translation reads back as
// 150.99999999999994. Round before comparing — the same trap that made probe-labels
// accuse A.1.0 of a detached label it had correctly moved.
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * A per-element structural fingerprint.
 *
 * Deliberately richer than gates.mjs::fingerprint, which records only
 * {id, type, name, src, tgt, host, default} and is therefore blind to a changed
 * condition expression, a mangled vendor extension, a node moved to another lane, and
 * a node reparented into a different container. All four are edits a model might make
 * by accident, and all four pass gate 4 today.
 */
function fingerprint(definitions) {
  const lanes = new Map();
  for (const el of walk(definitions)) {
    if (el.$type === 'bpmn:Lane') for (const r of el.flowNodeRef || []) if (r?.id) lanes.set(r.id, el.id);
  }
  const m = new Map();
  for (const el of walk(definitions)) {
    if (!el.id || !el.$type?.startsWith('bpmn:')) continue;
    const ref = (v) => (typeof v === 'string' ? v : v?.id ?? null);
    m.set(el.id, {
      type: el.$type,
      name: el.name ?? null,
      src: ref(el.sourceRef),
      tgt: ref(el.targetRef),
      host: ref(el.attachedToRef),
      def: ref(el.default),
      parent: el.$parent?.id ?? null,
      lane: lanes.get(el.id) ?? null,
      cond: el.conditionExpression?.body ?? null,
      ext: (el.extensionElements?.values || []).map((v) => v.$type).sort().join(','),
    });
  }
  return m;
}

// Shape and label geometry, keyed by the element the shape belongs to.
function geometry(definitions) {
  const m = new Map();
  for (const el of walk(definitions)) {
    if (el.$type !== 'bpmndi:BPMNShape' || !el.bpmnElement?.id || !el.bounds) continue;
    m.set(el.bpmnElement.id, {
      x: el.bounds.x, y: el.bounds.y,
      lx: el.label?.bounds?.x ?? null, ly: el.label?.bounds?.y ?? null,
    });
  }
  return m;
}

const countComments = (xml) => (xml.match(/<!--[\s\S]*?-->/g) || []).length;

export async function compare(beforeXml, afterXml, { expectedIds = [] } = {}) {
  const before = (await parse(beforeXml)).definitions;
  const after = (await parse(afterXml)).definitions;
  return compareTrees(before, after, { expectedIds, beforeXml, afterXml });
}

export function compareTrees(before, after, { expectedIds = [], beforeXml, afterXml } = {}) {
  const out = [];
  const expected = new Set(expectedIds);

  // --- 1. newly introduced static violations ---------------------------------
  const key = (d) => `${d.code}:${d.elements.join('|')}`;
  const had = new Set(inspectTree(before).map(key));
  for (const d of inspectTree(after)) {
    if (!had.has(key(d))) out.push(d);
  }

  // --- 2. content that disappeared -------------------------------------------
  const fa = fingerprint(before), fb = fingerprint(after);
  for (const [id, was] of fa) {
    if (fb.has(id) || expected.has(id)) continue;
    out.push(diag('CONTENT_LOST', `${was.type.replace('bpmn:', '')} ${was.name ?? id} was in the file before this edit and is not in it now.`, [id]));
  }

  // --- 3. content that changed without being asked to ------------------------
  for (const [id, now] of fb) {
    const was = fa.get(id);
    if (!was || expected.has(id)) continue;
    const fields = Object.keys(now).filter((k) => now[k] !== was[k]);
    if (fields.length) {
      out.push(diag('UNEXPECTED_CHANGE', `${now.type.replace('bpmn:', '')} ${now.name ?? id} changed (${fields.join(', ')}) but was not part of this edit.`, [id]));
    }
  }

  // --- 4. layout preservation -------------------------------------------------
  // F11's property, enforced at write time rather than measured after the fact.
  const ga = geometry(before), gb = geometry(after);
  const deltas = new Set();
  for (const [id, was] of ga) {
    const now = gb.get(id);
    if (!now) continue;
    const dx = r2(now.x - was.x), dy = r2(now.y - was.y);
    if (dx === 0 && dy === 0) continue;
    deltas.add(`${dx},${dy}`);
    if (was.lx !== null && now.lx !== null) {
      const ldx = r2(now.lx - was.lx), ldy = r2(now.ly - was.ly);
      if (ldx !== dx || ldy !== dy) {
        out.push(diag('LABEL_DETACHED', `The shape for ${id} moved by ${dx},${dy} but its label moved by ${ldx},${ldy}.`, [id]));
      }
    } else if (was.lx !== null && now.lx === null) {
      out.push(diag('LABEL_DETACHED', `The shape for ${id} moved and its label was dropped.`, [id]));
    }
  }
  if (deltas.size > 1) {
    out.push(diag('DIAGRAM_REFLOWED', `${deltas.size} different shape movements in one edit; making room produces exactly one.`, []));
  }

  // --- 5. unmodelled content (F10) -------------------------------------------
  if (typeof beforeXml === 'string' && typeof afterXml === 'string') {
    const lost = countComments(beforeXml) - countComments(afterXml);
    if (lost > 0) {
      out.push(diag('COMMENT_LOST', `${lost} XML comment${lost === 1 ? '' : 's'} present before this edit ${lost === 1 ? 'is' : 'are'} gone.`, []));
    }
  }

  return out;
}

/** Convenience for a write-guard: does anything here justify refusing the write? */
export const blocking = (diags) => diags.filter((d) => d.severity === 'error');
