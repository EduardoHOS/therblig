// What changed, structurally and geometrically.
//
// This is the measurement behind the receipt. It reads the moddle DI index rather than
// scraping the serialized text: gates.mjs::boundsList is a lazy regex that captures the
// first <Bounds> after each shape — always the shape's own, never its BPMNLabel's — and
// that blind spot is how F9 certified four files as preserved while twelve labels sat
// where the shapes used to be.
//
// The headline number is the Unintended Change Rate: of the objects this edit did NOT
// declare, what fraction changed anyway. A preservation claim is only worth something
// if the denominator is stated, so the receipt carries both.
import { parse, walk } from './model.mjs';

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * A per-element structural fingerprint.
 *
 * Richer than gates.mjs::fingerprint, which records only
 * {id, type, name, src, tgt, host, default} and is therefore blind to a changed
 * condition expression, a mangled vendor extension, a node moved to another lane, and a
 * node reparented into a different container. All four are edits a model can make by
 * accident, and all four pass gate 4.
 */
export function fingerprint(definitions) {
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

/** Shape and label geometry, keyed by the element the shape belongs to. */
export function geometry(definitions) {
  const m = new Map();
  for (const el of walk(definitions)) {
    if (el.$type !== 'bpmndi:BPMNShape' || !el.bpmnElement?.id || !el.bounds) continue;
    const lb = el.label?.bounds;
    m.set(el.bpmnElement.id, {
      x: el.bounds.x, y: el.bounds.y, w: el.bounds.width, h: el.bounds.height,
      lx: lb?.x ?? null, ly: lb?.y ?? null,
    });
  }
  return m;
}

/** Edge waypoints, keyed by flow id. */
export function edges(definitions) {
  const m = new Map();
  for (const el of walk(definitions)) {
    if (el.$type !== 'bpmndi:BPMNEdge' || !el.bpmnElement?.id || !el.waypoint) continue;
    m.set(el.bpmnElement.id, el.waypoint.map((p) => ({ x: p.x, y: p.y })));
  }
  return m;
}

// A multiset line count. Not an LCS: reordering is not churn for our purposes, and the
// number is reported as a rough size rather than a diff.
function lineCounts(a, b) {
  const count = (s) => {
    const m = new Map();
    for (const l of s.split('\n')) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const A = count(a), B = count(b);
  let removed = 0, added = 0;
  for (const [l, n] of A) removed += Math.max(0, n - (B.get(l) ?? 0));
  for (const [l, n] of B) added += Math.max(0, n - (A.get(l) ?? 0));
  return { removed, added };
}

export function semanticDiffTrees(before, after, { declared = [], beforeXml, afterXml } = {}) {
  const asked = new Set(declared);
  const fa = fingerprint(before), fb = fingerprint(after);
  const ga = geometry(before), gb = geometry(after);
  const ea = edges(before), eb = edges(after);

  const added = [...fb.keys()].filter((id) => !fa.has(id));
  const removed = [...fa.keys()].filter((id) => !fb.has(id));
  const changed = [], rewired = [];
  for (const [id, now] of fb) {
    const was = fa.get(id);
    if (!was) continue;
    const fields = Object.keys(now).filter((k) => now[k] !== was[k]);
    if (!fields.length) continue;
    (fields.includes('src') || fields.includes('tgt') ? rewired : changed).push({ id, fields });
  }

  // --- layout ---------------------------------------------------------------
  const deltas = new Map();
  let shapesMoved = 0, labelsDetached = 0;
  for (const [id, was] of ga) {
    const now = gb.get(id);
    if (!now) continue;
    const dx = r2(now.x - was.x), dy = r2(now.y - was.y);
    if (dx || dy) {
      shapesMoved++;
      const k = `${dx},${dy}`;
      deltas.set(k, (deltas.get(k) ?? 0) + 1);
      if (was.lx !== null && now.lx !== null) {
        if (r2(now.lx - was.lx) !== dx || r2(now.ly - was.ly) !== dy) labelsDetached++;
      } else if (was.lx !== null && now.lx === null) labelsDetached++;
    }
  }
  let waypointsMoved = 0;
  for (const [id, was] of ea) {
    const now = eb.get(id);
    if (!now || now.length !== was.length) { if (now) waypointsMoved++; continue; }
    if (was.some((p, i) => r2(p.x - now[i].x) !== 0 || r2(p.y - now[i].y) !== 0)) waypointsMoved++;
  }

  // --- protected objects ----------------------------------------------------
  // Everything the edit did not declare. Stating the denominator is the point: "nothing
  // moved" means little without "out of how many".
  const protectedIds = [...fa.keys()].filter((id) => !asked.has(id));
  const unintended = [];
  for (const id of protectedIds) {
    const was = fa.get(id), now = fb.get(id);
    if (!now) { unintended.push({ id, why: 'removed' }); continue; }
    const fields = Object.keys(now).filter((k) => now[k] !== was[k]);
    if (fields.length) unintended.push({ id, why: fields.join(',') });
  }

  return {
    semantic: { added, removed, changed, rewired },
    layout: {
      shapesTotal: ga.size,
      shapesMoved,
      distinctDeltas: deltas.size,
      deltas: [...deltas.entries()].map(([d, n]) => ({ delta: d, shapes: n })),
      rigid: deltas.size <= 1,
      labelsDetached,
      waypointsMoved,
    },
    protectedObjects: {
      total: protectedIds.length,
      unintendedChanges: unintended.length,
      ucr: protectedIds.length ? r2((unintended.length / protectedIds.length) * 100) : 0,
      offenders: unintended.slice(0, 20),
    },
    lines: beforeXml && afterXml ? lineCounts(beforeXml, afterXml) : null,
  };
}

export async function semanticDiff(beforeXml, afterXml, { declared = [] } = {}) {
  const before = (await parse(beforeXml)).definitions;
  const after = (await parse(afterXml)).definitions;
  return semanticDiffTrees(before, after, { declared, beforeXml, afterXml });
}

/** One line, in the product voice: numbers over adjectives, one period. */
export function headline(d) {
  const bits = [];
  if (d.semantic.added.length) bits.push(`+${d.semantic.added.length}`);
  if (d.semantic.removed.length) bits.push(`−${d.semantic.removed.length}`);
  if (d.semantic.changed.length) bits.push(`~${d.semantic.changed.length}`);
  const p = d.protectedObjects;
  return `${bits.join(' ') || 'no structural change'} · ${p.unintendedChanges} of ${p.total} protected objects changed, UCR ${p.ucr}%`;
}
