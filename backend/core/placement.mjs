import { index, walk } from './document.mjs';

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

function shiftDownstream(byElement, start, distance) {
  let movedShapes = 0;
  for (const diagram of byElement.values()) {
    if (
      diagram.$type !== 'bpmndi:BPMNShape' ||
      !diagram.bounds ||
      diagram.bounds.x < start.x
    ) {
      continue;
    }
    diagram.bounds.x += distance;
    movedShapes++;
  }
  for (const diagram of byElement.values()) {
    if (diagram.$type !== 'bpmndi:BPMNEdge' || !diagram.waypoint) continue;
    for (const waypoint of diagram.waypoint) {
      if (waypoint.x >= start.x) waypoint.x += distance;
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

function nodePosition(element, byElement, width, height) {
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
      movedShapes: shiftDownstream(byElement, next, distance),
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
    if (element.$type === 'bpmn:SequenceFlow' || element.$type === 'bpmn:MessageFlow') continue;

    const [width, height] = sizeOf(element);
    const position = nodePosition(element, context.byElement, width, height);
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

function placeEdges(context, ids) {
  const placed = [];
  for (const id of ids) {
    const element = context.byId.get(id);
    if (!element || context.byElement.has(id)) continue;
    if (element.$type !== 'bpmn:SequenceFlow' && element.$type !== 'bpmn:MessageFlow') continue;

    const source = bounds(context.byElement.get(element.sourceRef?.id));
    const target = bounds(context.byElement.get(element.targetRef?.id));
    if (!source || !target) continue;

    const from = { x: source.x + source.width, y: source.y + source.height / 2 };
    const to = { x: target.x, y: target.y + target.height / 2 };
    const middleX = from.x + (to.x - from.x) / 2;
    const points =
      from.y === to.y
        ? [from, to]
        : [from, { x: middleX, y: from.y }, { x: middleX, y: to.y }, to];
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

const NEEDS_SHAPE =
  /^bpmn:(Start|End|Boundary|IntermediateCatch|IntermediateThrow)Event$|^bpmn:(User|Service|Script|Manual|Send|Receive|BusinessRule)?Task$|^bpmn:(Sub|AdHocSub)Process$|^bpmn:Transaction$|^bpmn:CallActivity$|^bpmn:(Exclusive|Parallel|Inclusive|EventBased|Complex)Gateway$|^bpmn:Participant$|^bpmn:Lane$/;
const NEEDS_EDGE = /^bpmn:(SequenceFlow|MessageFlow)$/;

export function diCoverage(definitions) {
  const { byElement } = diIndex(definitions);
  const missing = [];
  let required = 0;

  for (const element of walk(definitions)) {
    if (!element.id || !element.$type) continue;
    if (!NEEDS_SHAPE.test(element.$type) && !NEEDS_EDGE.test(element.$type)) continue;
    required++;
    if (!byElement.has(element.id)) missing.push({ id: element.id, type: element.$type });
  }

  return {
    ok: missing.length === 0,
    need: required,
    covered: required - missing.length,
    missing,
  };
}
