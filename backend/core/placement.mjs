import { containerOf, index, walk } from './document.mjs';

const SIZE = {
  'bpmn:StartEvent': [36, 36],
  'bpmn:EndEvent': [36, 36],
  'bpmn:IntermediateCatchEvent': [36, 36],
  'bpmn:IntermediateThrowEvent': [36, 36],
  'bpmn:BoundaryEvent': [36, 36],
  'bpmn:ExclusiveGateway': [50, 50],
  'bpmn:ParallelGateway': [50, 50],
  'bpmn:InclusiveGateway': [50, 50],
  'bpmn:EventBasedGateway': [50, 50],
  'bpmn:ComplexGateway': [50, 50],
  'bpmn:SubProcess': [350, 200],
  'bpmn:Transaction': [350, 200],
};
const DEFAULT_SIZE = [100, 80];
const GAP = 50;

// Placement positions a flow node beside its neighbours. It cannot meaningfully position
// a pool or a lane, whose geometry derives from what they hold, and it must never be
// handed a process: `del` reports the containing process in `changed`, so the obvious
// placeNew([...changed, ...created]) once minted a BPMNShape for the bpmn:Process itself
// and every gate passed it. See docs/FINDINGS.md F12.
const PLACEABLE =
  /^bpmn:(Start|End|Boundary|IntermediateCatch|IntermediateThrow)Event$|^bpmn:(User|Service|Script|Manual|Send|Receive|BusinessRule)?Task$|^bpmn:(Sub|AdHocSub)Process$|^bpmn:Transaction$|^bpmn:CallActivity$|^bpmn:(Exclusive|Parallel|Inclusive|EventBased|Complex)Gateway$/;
const CONTAINER_SHAPE = /^bpmn:(Participant|Lane)$/;

function sizeOf(element) {
  return SIZE[element.$type] ?? DEFAULT_SIZE;
}

function diIndex(definitions) {
  const planes = [];
  const byElement = new Map();
  for (const element of walk(definitions)) {
    if (element.$type === 'bpmndi:BPMNPlane') planes.push(element);
    if (
      (element.$type === 'bpmndi:BPMNShape' || element.$type === 'bpmndi:BPMNEdge') &&
      element.bpmnElement?.id
    ) {
      byElement.set(element.bpmnElement.id, element);
    }
  }
  return { planes, byElement };
}

function planeFor(planes, byElement, element) {
  let parent = element.$parent;
  while (parent) {
    const diagram = byElement.get(parent.id);
    if (diagram?.$parent?.$type === 'bpmndi:BPMNPlane') return diagram.$parent;
    for (const plane of planes) {
      if (plane.bpmnElement?.id === parent.id) return plane;
    }
    parent = parent.$parent;
  }
  return planes[0];
}

// The outermost process an element sits in. containerOf stops at the nearest
// sub-process, which is right for scoping an edit and wrong for deciding whether two
// elements share a pool.
function poolProcessOf(element) {
  let parent = element?.$parent;
  let outermost = null;
  while (parent) {
    if (parent.$type === 'bpmn:Process') outermost = parent;
    parent = parent.$parent;
  }
  return outermost;
}

function bounds(diagram) {
  if (!diagram?.bounds) return null;
  return {
    x: diagram.bounds.x,
    y: diagram.bounds.y,
    width: diagram.bounds.width,
    height: diagram.bounds.height,
  };
}

function planeElementsOf(plane) {
  plane.planeElement ??= [];
  return plane.planeElement;
}

/**
 * Move a shape and the label that names it, together.
 *
 * A BPMN label is a sibling `<BPMNLabel><dc:Bounds>` beside the shape's own bounds, not a
 * property of it, so a translation touching only `bounds` slides the shape out from under
 * its own text. Events and gateways carry external labels; tasks render theirs inside the
 * shape and have none, which is why files made only of tasks looked clean.
 *
 * The gate that graded this could not see it — it read shape bounds with a regex that
 * cannot reach a BPMNLabel — so four files were certified as preserved while twelve
 * labels stayed behind. See docs/FINDINGS.md F11.
 */
function translateShape(diagram, distance) {
  if (diagram.bounds) diagram.bounds.x += distance;
  if (diagram.label?.bounds) diagram.label.bounds.x += distance;
}

function translateEdge(diagram, distance, threshold) {
  if (diagram.waypoint) {
    for (const waypoint of diagram.waypoint) {
      if (waypoint.x >= threshold) waypoint.x += distance;
    }
  }
  if (diagram.label?.bounds && diagram.label.bounds.x >= threshold) {
    diagram.label.bounds.x += distance;
  }
}

/**
 * Make room to the right of `start`, within the container being edited.
 *
 * This used to run over every diagram element with a bare `bounds.x >= start.x` test, so
 * inserting into one pool translated shapes in every other pool that happened to sit to
 * the right. Pools and lanes are never translated: a container
 * left too narrow needs resizing, which is a different operation.
 */
function shiftDownstream(byElement, start, distance, container) {
  let movedShapes = 0;
  for (const diagram of byElement.values()) {
    const target = diagram.bpmnElement;
    // Container alone, without a separate plane check: two planes cannot hold elements
    // of the same container, so the plane test could never fire on its own. Elements of
    // a sub-process plane have that sub-process as their container; the pools of a
    // collaboration have their own processes; participants have none. All already
    // excluded here.
    if (!target || containerOf(target) !== container) continue;

    if (diagram.$type === 'bpmndi:BPMNShape') {
      if (CONTAINER_SHAPE.test(target.$type)) continue;
      if (!diagram.bounds || diagram.bounds.x < start.x) continue;
      translateShape(diagram, distance);
      movedShapes++;
    } else if (diagram.$type === 'bpmndi:BPMNEdge') {
      translateEdge(diagram, distance, start.x);
    }
  }
  return movedShapes;
}

function unanchoredPosition(byElement) {
  let maximumY = 0;
  let minimumX = Number.POSITIVE_INFINITY;
  for (const diagram of byElement.values()) {
    if (!diagram.bounds) continue;
    maximumY = Math.max(maximumY, diagram.bounds.y + diagram.bounds.height);
    minimumX = Math.min(minimumX, diagram.bounds.x);
  }
  return {
    x: Number.isFinite(minimumX) ? minimumX : 150,
    y: maximumY + 80,
  };
}

function nodePosition(element, context, width, height) {
  const { byElement } = context;
  if (element.attachedToRef) {
    const host = bounds(byElement.get(element.attachedToRef.id));
    if (!host) return null;
    return {
      x: host.x + host.width - 20 - width / 2,
      y: host.y + host.height - height / 2,
      movedShapes: 0,
    };
  }

  const incoming = (element.incoming || [])
    .map((flow) => bounds(byElement.get(flow.sourceRef?.id)))
    .filter(Boolean);
  const outgoing = (element.outgoing || [])
    .map((flow) => bounds(byElement.get(flow.targetRef?.id)))
    .filter(Boolean);
  const previous = incoming[0];
  const next = outgoing[0];

  if (previous && next) {
    const gapStart = previous.x + previous.width;
    const gapWidth = next.x - gapStart;
    if (gapWidth >= width + 2 * GAP) {
      return {
        x: gapStart + (gapWidth - width) / 2,
        y: previous.y + previous.height / 2 - height / 2,
        movedShapes: 0,
      };
    }
    const distance = width + 2 * GAP - gapWidth;
    return {
      x: gapStart + GAP,
      y: previous.y + previous.height / 2 - height / 2,
      movedShapes: shiftDownstream(byElement, next, distance, containerOf(element)),
    };
  }
  if (previous) {
    return {
      x: previous.x + previous.width + GAP,
      y: previous.y + previous.height / 2 - height / 2,
      movedShapes: 0,
    };
  }
  if (next) {
    return {
      x: next.x - width - GAP,
      y: next.y + next.height / 2 - height / 2,
      movedShapes: 0,
    };
  }
  return { ...unanchoredPosition(byElement), movedShapes: 0 };
}

function placeNodes(context, ids) {
  const placed = [];
  let movedShapes = 0;

  for (const id of ids) {
    const element = context.byId.get(id);
    if (!element || context.byElement.has(id)) continue;
    if (!PLACEABLE.test(element.$type)) continue;

    const [width, height] = sizeOf(element);
    const position = nodePosition(element, context, width, height);
    if (!position) continue;
    const plane = planeFor(context.planes, context.byElement, element);

    movedShapes += position.movedShapes;
    const shape = context.moddle.create('bpmndi:BPMNShape', {
      id: `${id}_di`,
      bpmnElement: element,
      bounds: context.moddle.create('dc:Bounds', {
        x: Math.round(position.x),
        y: Math.round(position.y),
        width,
        height,
      }),
    });
    if (/SubProcess|Transaction/.test(element.$type) && element.flowElements?.length) {
      shape.isExpanded = true;
    }
    shape.$parent = plane;
    planeElementsOf(plane).push(shape);
    context.byElement.set(id, shape);
    placed.push(id);
  }

  return { placed, movedShapes };
}

/**
 * Dock on whichever pair of edges the two shapes actually face.
 *
 * A sequence flow inside one pool runs left to right. A message flow between two pools
 * runs up or down, and docking it right-to-left sends it out of one pool, across the page
 * and back in. Compare the gaps rather than assuming.
 */
function waypointsBetween(source, target) {
  const forwardX = target.x - (source.x + source.width);
  const backwardX = source.x - (target.x + target.width);
  const forwardY = target.y - (source.y + source.height);
  const backwardY = source.y - (target.y + target.height);

  if (Math.max(forwardY, backwardY) > Math.max(forwardX, backwardX)) {
    const downward = forwardY >= backwardY;
    const from = { x: source.x + source.width / 2, y: downward ? source.y + source.height : source.y };
    const to = { x: target.x + target.width / 2, y: downward ? target.y : target.y + target.height };
    const middleY = from.y + (to.y - from.y) / 2;
    return from.x === to.x
      ? [from, to]
      : [from, { x: from.x, y: middleY }, { x: to.x, y: middleY }, to];
  }

  const from = { x: source.x + source.width, y: source.y + source.height / 2 };
  const to = { x: target.x, y: target.y + target.height / 2 };
  const middleX = from.x + (to.x - from.x) / 2;
  return from.y === to.y
    ? [from, to]
    : [from, { x: middleX, y: from.y }, { x: middleX, y: to.y }, to];
}

function placeEdges(context, ids) {
  const placed = [];
  for (const id of ids) {
    const element = context.byId.get(id);
    if (!element || context.byElement.has(id)) continue;
    if (!NEEDS_EDGE.test(element.$type)) continue;

    const source = bounds(context.byElement.get(element.sourceRef?.id));
    const target = bounds(context.byElement.get(element.targetRef?.id));
    if (!source || !target) continue;

    const points = waypointsBetween(source, target);
    const plane = planeFor(context.planes, context.byElement, element);

    const edge = context.moddle.create('bpmndi:BPMNEdge', {
      id: `${id}_di`,
      bpmnElement: element,
      waypoint: points.map((point) =>
        context.moddle.create('dc:Point', {
          x: Math.round(point.x),
          y: Math.round(point.y),
        }),
      ),
    });
    edge.$parent = plane;
    planeElementsOf(plane).push(edge);
    context.byElement.set(id, edge);
    placed.push(id);
  }
  return placed;
}

export function placeNew({ moddle, definitions }, ids) {
  const { planes, byElement } = diIndex(definitions);
  if (!planes.length) {
    return { placed: [], movedShapes: 0, reason: 'no BPMNPlane — file has no DI at all' };
  }

  const context = { moddle, byId: index(definitions), planes, byElement };
  const nodePlacement = placeNodes(context, ids);
  const placed = [...nodePlacement.placed, ...placeEdges(context, ids)];
  return { placed, movedShapes: nodePlacement.movedShapes };
}

/**
 * Remove diagram elements whose bpmnElement no longer exists.
 *
 * `del` used to remove semantics and leave the plane untouched, so a shape survived
 * pointing at a deleted element — and coverage reported 100%, because it only ever asked
 * elements to DI. See docs/FINDINGS.md F12.
 */
export function pruneDI(definitions) {
  const live = index(definitions);
  const removed = [];
  for (const element of walk(definitions)) {
    if (element.$type !== 'bpmndi:BPMNPlane' || !element.planeElement) continue;
    for (let position = element.planeElement.length - 1; position >= 0; position--) {
      const target = element.planeElement[position].bpmnElement;
      const targetId = target?.id;
      if (targetId && !live.has(targetId)) {
        element.planeElement.splice(position, 1);
        removed.push(targetId);
      }
    }
  }
  return removed;
}

const NEEDS_SHAPE =
  /^bpmn:(Start|End|Boundary|IntermediateCatch|IntermediateThrow)Event$|^bpmn:(User|Service|Script|Manual|Send|Receive|BusinessRule)?Task$|^bpmn:(Sub|AdHocSub)Process$|^bpmn:Transaction$|^bpmn:CallActivity$|^bpmn:(Exclusive|Parallel|Inclusive|EventBased|Complex)Gateway$|^bpmn:Participant$|^bpmn:Lane$/;
const NEEDS_EDGE = /^bpmn:(SequenceFlow|MessageFlow)$/;

// A collapsed sub-process draws as one box and its children are deliberately not on the
// plane. A process no plane draws needs no DI at all. Both exemptions were found by
// running real files rather than fixtures: every collapsed sub-process in the MIWG corpus
// is empty, and two files carry a process referenced by a call activity and never
// rendered. Without them the barrier refuses ordinary edits. See F16 and F17.
function exemptFromDI(definitions, byElement) {
  const collapsed = new Set();
  for (const [elementId, diagram] of byElement) {
    if (diagram.$type === 'bpmndi:BPMNShape' && diagram.isExpanded === false) collapsed.add(elementId);
  }

  const drawn = new Set();
  for (const element of walk(definitions)) {
    if (!element.id || !byElement.has(element.id)) continue;
    const process = poolProcessOf(element);
    if (process?.id) drawn.add(process.id);
  }

  return (element) => {
    let parent = element.$parent;
    while (parent) {
      if (parent.id && collapsed.has(parent.id)) return true;
      parent = parent.$parent;
    }
    const process = poolProcessOf(element);
    return Boolean(process && drawn.size && !drawn.has(process.id));
  };
}

export function diCoverage(definitions) {
  const { byElement } = diIndex(definitions);
  const live = index(definitions);
  const exempt = exemptFromDI(definitions, byElement);
  const missing = [];
  let required = 0;

  for (const element of walk(definitions)) {
    if (!element.id || !element.$type) continue;
    if (!NEEDS_SHAPE.test(element.$type) && !NEEDS_EDGE.test(element.$type)) continue;
    if (exempt(element)) continue;
    required++;
    if (!byElement.has(element.id)) missing.push({ id: element.id, type: element.$type });
  }

  // Both directions. Asking only elements-to-DI is what let orphaned shapes report as
  // fully covered.
  const orphans = [];
  for (const [elementId, diagram] of byElement) {
    if (!live.has(elementId)) orphans.push({ id: elementId, type: diagram.$type });
  }

  return {
    ok: missing.length === 0 && orphans.length === 0,
    need: required,
    covered: required - missing.length,
    missing,
    orphans,
  };
}
