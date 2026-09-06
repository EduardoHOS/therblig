// Incremental DI placement: give new elements a shape or edge without touching
// anything that already has one.
//
// This exists because full-file auto-layout fails on 41% of the OMG's own reference
// models (docs/FINDINGS.md F4). We never re-run it on a file that already has DI.
// Instead: a new node goes where a human would put it — next to its neighbours —
// and only shapes downstream of the insertion move, by exactly one column.
import { index } from './model.mjs';

const SIZE = {
  'bpmn:StartEvent': [36, 36], 'bpmn:EndEvent': [36, 36],
  'bpmn:IntermediateCatchEvent': [36, 36], 'bpmn:IntermediateThrowEvent': [36, 36],
  'bpmn:BoundaryEvent': [36, 36],
  'bpmn:ExclusiveGateway': [50, 50], 'bpmn:ParallelGateway': [50, 50],
  'bpmn:InclusiveGateway': [50, 50], 'bpmn:EventBasedGateway': [50, 50],
  'bpmn:ComplexGateway': [50, 50],
  'bpmn:SubProcess': [350, 200], 'bpmn:Transaction': [350, 200],
};
const DEFAULT_SIZE = [100, 80];
const GAP = 50;

// What needs DI at all. Declared above placeNew because placeNew must filter its own
// id list through it: `del` reports the CONTAINER id in `changed` (ir.mjs), so the
// obvious placeNew([...changed, ...created]) used to mint a
// <BPMNShape bpmnElement="SomeProcess"> for the bpmn:Process itself — and all five
// gates passed it. See FINDINGS.md F12 (D4).
const NEEDS_SHAPE = /^bpmn:(Start|End|Boundary|IntermediateCatch|IntermediateThrow)Event$|^bpmn:(User|Service|Script|Manual|Send|Receive|BusinessRule)?Task$|^bpmn:(Sub|AdHocSub)Process$|^bpmn:Transaction$|^bpmn:CallActivity$|^bpmn:(Exclusive|Parallel|Inclusive|EventBased|Complex)Gateway$|^bpmn:Participant$|^bpmn:Lane$/;
const NEEDS_EDGE = /^bpmn:(SequenceFlow|MessageFlow)$/;

// placeNew can position a flow node next to its neighbours. It cannot meaningfully
// position a pool or a lane — those are containers whose geometry derives from what
// they hold — so it declines them rather than guessing.
const PLACEABLE_SHAPE = /^bpmn:(Start|End|Boundary|IntermediateCatch|IntermediateThrow)Event$|^bpmn:(User|Service|Script|Manual|Send|Receive|BusinessRule)?Task$|^bpmn:(Sub|AdHocSub)Process$|^bpmn:Transaction$|^bpmn:CallActivity$|^bpmn:(Exclusive|Parallel|Inclusive|EventBased|Complex)Gateway$/;

const CONTAINER = /^bpmn:(Process|SubProcess|Transaction|AdHocSubProcess|Collaboration)$/;

function sizeOf(el) {
  return SIZE[el.$type] ?? DEFAULT_SIZE;
}

function* walk(el, seen = new Set()) {
  if (!el || typeof el !== 'object' || seen.has(el)) return;
  seen.add(el);
  yield el;
  for (const k of Object.keys(el)) {
    if (k === '$parent' || k === '$model' || k === '$descriptor') continue;
    const v = el[k];
    if (Array.isArray(v)) for (const c of v) yield* walk(c, seen);
    else if (v && typeof v === 'object') yield* walk(v, seen);
  }
}

// Every BPMNPlane in the document, and the DI entries on it, keyed by element id.
function diIndex(definitions) {
  const planes = [];
  const byElement = new Map();
  for (const el of walk(definitions)) {
    if (el.$type === 'bpmndi:BPMNPlane') planes.push(el);
    if ((el.$type === 'bpmndi:BPMNShape' || el.$type === 'bpmndi:BPMNEdge') && el.bpmnElement?.id) {
      byElement.set(el.bpmnElement.id, el);
    }
  }
  return { planes, byElement };
}

function planeFor(planes, byElement, el) {
  // Put a new shape on the plane that already holds its siblings.
  let p = el.$parent;
  while (p) {
    const di = byElement.get(p.id);
    if (di?.$parent?.$type === 'bpmndi:BPMNPlane') return di.$parent;
    for (const plane of planes) if (plane.bpmnElement?.id === p.id) return plane;
    p = p.$parent;
  }
  return planes[0] ?? null;
}

// The process, sub-process or collaboration an element lives in. Two elements with
// different containers are in different pools or different sub-process bodies, and
// making room in one must not move the other.
function containerIdOf(el) {
  let p = el?.$parent;
  while (p && !CONTAINER.test(p.$type)) p = p.$parent;
  return p?.id ?? null;
}

function bounds(di) {
  return di?.bounds ? { x: di.bounds.x, y: di.bounds.y, w: di.bounds.width, h: di.bounds.height } : null;
}

/**
 * Move a shape and its label together.
 *
 * A BPMN label is a separate <bpmndi:BPMNLabel><dc:Bounds> beside the shape's own
 * bounds, not a property of it — so a translation touching only di.bounds slides the
 * shape out from under its own text. Events and gateways carry external labels; tasks
 * render theirs inside the shape and have none, which is why the files that looked
 * clean were the task-only ones.
 *
 * Gate 5 could not see this: boundsList() matched the FIRST <Bounds> after each
 * BPMNShape, which is always the shape's own. So F9 certified four files as rigid
 * translations while twelve labels stayed behind. See FINDINGS.md F11.
 */
function translateShape(di, dx) {
  if (di.bounds) di.bounds.x += dx;
  if (di.label?.bounds) di.label.bounds.x += dx;
}

// The same obligation for edges: waypoints past the threshold, and the edge's label.
function translateEdge(di, dx, threshold) {
  if (di.waypoint) for (const wp of di.waypoint) if (wp.x >= threshold) wp.x += dx;
  if (di.label?.bounds && di.label.bounds.x >= threshold) di.label.bounds.x += dx;
}

/**
 * Places DI for every element in `ids` that has none.
 * Returns { placed, movedShapes } so the caller can report honestly how much moved.
 */
export function placeNew({ moddle, definitions }, ids) {
  const byId = index(definitions);
  const { planes, byElement } = diIndex(definitions);
  if (!planes.length) return { placed: [], movedShapes: 0, reason: 'no BPMNPlane — file has no DI at all' };

  const placed = [];
  let movedShapes = 0;

  // --- nodes first, so edges can dock to real geometry ---------------------
  for (const id of ids) {
    const el = byId.get(id);
    if (!el || byElement.has(id)) continue;
    if (!PLACEABLE_SHAPE.test(el.$type)) continue;  // never a Process, Collaboration, pool or lane

    const [w, h] = sizeOf(el);
    let x, y;

    if (el.attachedToRef) {
      // Boundary event: dock on the host's bottom edge, offset right of centre.
      const host = bounds(byElement.get(el.attachedToRef.id));
      if (!host) continue;
      x = host.x + host.w - 20 - w / 2;
      y = host.y + host.h - h / 2;
    } else {
      // Flow node: sit between its predecessor and successor.
      const incoming = (el.incoming || []).map((f) => bounds(byElement.get(f.sourceRef?.id))).filter(Boolean);
      const outgoing = (el.outgoing || []).map((f) => bounds(byElement.get(f.targetRef?.id))).filter(Boolean);
      const prev = incoming[0], next = outgoing[0];
      if (prev && next) {
        const gapStart = prev.x + prev.w;
        const gapWidth = next.x - gapStart;
        if (gapWidth >= w + 2 * GAP) {
          x = gapStart + (gapWidth - w) / 2;              // it fits: nothing moves
        } else {
          x = gapStart + GAP;                              // make room: shift downstream
          const shift = w + 2 * GAP - gapWidth;

          // Scope. The shift used to run over the whole byElement map with a bare
          // `di.bounds.x >= next.x` test, so inserting into one pool moved shapes in
          // every other pool and on every other plane that happened to sit to the
          // right. Confine it to the plane being drawn on and the container being
          // edited. Pools and lanes are containers whose geometry derives from their
          // contents, so they are never translated — a pool that is now too narrow is
          // a known limitation (it needs resizing, not moving) and is not this fix.
          const myPlane = planeFor(planes, byElement, el);
          const myContainer = containerIdOf(el);

          for (const [otherId, di] of byElement) {
            if (otherId === id) continue;
            if (di.$parent !== myPlane) continue;
            const target = di.bpmnElement;
            if (!target || containerIdOf(target) !== myContainer) continue;

            if (di.$type === 'bpmndi:BPMNShape') {
              if (/^bpmn:(Participant|Lane)$/.test(target.$type)) continue;
              if (!di.bounds || di.bounds.x < next.x) continue;
              translateShape(di, shift);
              movedShapes++;
            } else if (di.$type === 'bpmndi:BPMNEdge') {
              translateEdge(di, shift, next.x);
            }
          }
        }
        y = prev.y + prev.h / 2 - h / 2;
      } else if (prev) {
        x = prev.x + prev.w + GAP;
        y = prev.y + prev.h / 2 - h / 2;
      } else if (next) {
        x = next.x - w - GAP;
        y = next.y + next.h / 2 - h / 2;
      } else {
        // Nothing to anchor to: park below the existing content.
        let maxY = 0, minX = Infinity;
        for (const [, di] of byElement) if (di.bounds) { maxY = Math.max(maxY, di.bounds.y + di.bounds.height); minX = Math.min(minX, di.bounds.x); }
        x = Number.isFinite(minX) ? minX : 150;
        y = maxY + 80;
      }
    }

    const plane = planeFor(planes, byElement, el);
    if (!plane) continue;
    const shape = moddle.create('bpmndi:BPMNShape', {
      id: `${id}_di`,
      bpmnElement: el,
      bounds: moddle.create('dc:Bounds', { x: Math.round(x), y: Math.round(y), width: w, height: h }),
    });
    if (/SubProcess|Transaction/.test(el.$type) && el.flowElements?.length) shape.isExpanded = true;
    shape.$parent = plane;
    plane.planeElement.push(shape);
    byElement.set(id, shape);
    placed.push(id);
  }

  // --- then edges ----------------------------------------------------------
  for (const id of ids) {
    const el = byId.get(id);
    if (!el || byElement.has(id)) continue;
    if (!NEEDS_EDGE.test(el.$type)) continue;
    const a = bounds(byElement.get(el.sourceRef?.id));
    const b = bounds(byElement.get(el.targetRef?.id));
    if (!a || !b) continue;

    // Dock on whichever pair of edges the two shapes actually face. A sequence flow
    // inside one pool runs left to right; a message flow between two pools runs up or
    // down, and docking it right-to-left would send it out of one pool, across the
    // page and back in. Compare the gaps rather than assuming.
    const dx = b.x - (a.x + a.w), dxBack = a.x - (b.x + b.w);
    const dy = b.y - (a.y + a.h), dyBack = a.y - (b.y + b.h);
    const vertical = Math.max(dy, dyBack) > Math.max(dx, dxBack);

    let from, to, points;
    if (vertical) {
      const downward = dy >= dyBack;
      from = { x: a.x + a.w / 2, y: downward ? a.y + a.h : a.y };
      to = { x: b.x + b.w / 2, y: downward ? b.y : b.y + b.h };
      points = from.x === to.x
        ? [from, to]
        : [from, { x: from.x, y: from.y + (to.y - from.y) / 2 }, { x: to.x, y: from.y + (to.y - from.y) / 2 }, to];
    } else {
      from = { x: a.x + a.w, y: a.y + a.h / 2 };
      to = { x: b.x, y: b.y + b.h / 2 };
      points = from.y === to.y
        ? [from, to]
        : [from, { x: from.x + (to.x - from.x) / 2, y: from.y }, { x: from.x + (to.x - from.x) / 2, y: to.y }, to];
    }

    const plane = planeFor(planes, byElement, el);
    if (!plane) continue;
    const edge = moddle.create('bpmndi:BPMNEdge', {
      id: `${id}_di`,
      bpmnElement: el,
      waypoint: points.map((p) => moddle.create('dc:Point', { x: Math.round(p.x), y: Math.round(p.y) })),
    });
    edge.$parent = plane;
    plane.planeElement.push(edge);
    byElement.set(id, edge);
    placed.push(id);
  }

  return { placed, movedShapes };
}

/**
 * The gate from ADR-005: every element that needs DI must have it — and no DI may
 * point at an element that is gone. Both directions, because asking only
 * elements->DI is what let orphaned shapes report as 100% covered.
 *
 * Run after any operation that touches the model. The layouter's own warnings
 * channel is not trusted — C.4.0 lost 52 elements and reported none.
 */
export function diCoverage(definitions) {
  const { byElement } = diIndex(definitions);
  const live = index(definitions);

  // A collapsed sub-process draws as a single box: its children are deliberately not
  // on the plane, and demanding shapes for them refuses every edit to an ordinary
  // Camunda file. Every collapsed sub-process in the MIWG corpus happens to be empty,
  // so nothing caught this until bench/corpus/handmade/collapsed-subprocess.bpmn was
  // written to catch it — a normal file that reported 5 elements missing.
  const collapsed = new Set();
  for (const [elId, di] of byElement) {
    if (di.$type === 'bpmndi:BPMNShape' && di.isExpanded === false) collapsed.add(elId);
  }
  const insideCollapsed = (el) => {
    let p = el.$parent;
    while (p) {
      if (p.id && collapsed.has(p.id)) return true;
      p = p.$parent;
    }
    return false;
  };

  // A process no plane draws needs no DI at all. B.1.0 and B.2.0 each carry a small
  // process referenced by a call activity and never rendered; demanding shapes for it
  // reported five missing elements per file and would have refused every edit to them.
  // Same shape of bug as the collapsed sub-process above, found by the corpus sweep.
  const topProcessOf = (el) => {
    let p = el.$parent, last = null;
    while (p) { if (p.$type === 'bpmn:Process') last = p; p = p.$parent; }
    return last;
  };
  const drawn = new Set();
  for (const el of walk(definitions)) {
    if (!el.id || !byElement.has(el.id)) continue;
    const proc = topProcessOf(el) ?? (el.$type === 'bpmn:Process' ? el : null);
    if (proc?.id) drawn.add(proc.id);
  }

  const missing = [];
  let need = 0;
  for (const el of walk(definitions)) {
    if (!el.id || !el.$type) continue;
    if (!NEEDS_SHAPE.test(el.$type) && !NEEDS_EDGE.test(el.$type)) continue;
    if (insideCollapsed(el)) continue;
    const proc = topProcessOf(el);
    if (proc && drawn.size && !drawn.has(proc.id)) continue;
    need++;
    if (!byElement.has(el.id)) missing.push({ id: el.id, type: el.$type });
  }
  const orphans = [];
  for (const [elId, di] of byElement) if (!live.has(elId)) orphans.push({ id: elId, type: di.$type });
  return {
    ok: missing.length === 0 && orphans.length === 0,
    need, covered: need - missing.length, missing, orphans,
  };
}
