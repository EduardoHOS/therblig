import { linkFlow, retarget, unlinkFlow } from './adjacency.mjs';
import { contained, containerOf, index, walk } from './document.mjs';
import { block } from './registry.mjs';

export function mintId(byId, base) {
  const slug =
    String(base).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'Element';
  let id = slug;
  let suffix = 1;
  while (byId.has(id)) id = `${slug}_${++suffix}`;
  return id;
}

function flowNodesOf(container) {
  container.flowElements ??= [];
  return container.flowElements;
}

function insertionFor(byId, container, operation) {
  if (!operation.after && !operation.between) return null;

  const [sourceId, targetId] = operation.between ?? [operation.after, null];
  const source = byId.get(sourceId);
  if (!source) throw new Error(`Node "${sourceId}" not found`);

  const target = targetId ? byId.get(targetId) : null;
  if (targetId && !target) throw new Error(`Node "${targetId}" not found`);

  const existingFlows = container.flowElements.filter(
    (flow) =>
      flow.$type === 'bpmn:SequenceFlow' &&
      flow.sourceRef?.id === sourceId &&
      (!targetId || flow.targetRef?.id === targetId),
  );
  return { existingFlows, target: target ?? existingFlows[0]?.targetRef };
}

function addNode({ moddle, byId, changed, created }, operation) {
  const definition = block(operation.type);

  const container = byId.get(operation.in);
  if (!container) throw new Error(`Container "${operation.in}" not found`);
  const insertion = insertionFor(byId, container, operation);

  const id =
    operation.id && !byId.has(operation.id)
      ? operation.id
      : mintId(byId, operation.id || operation.name || operation.type);
  const element = moddle.create(definition.bpmn, {
    id,
    ...(operation.name ? { name: operation.name } : {}),
  });
  definition.build?.(element, operation, { moddle, byId });

  element.$parent = container;
  flowNodesOf(container).push(element);
  byId.set(id, element);
  changed.add(id);
  created.push(id);

  if (!insertion) return;

  for (const flow of insertion.existingFlows) {
    retarget(flow, element);
    changed.add(flow.id);
  }
  if (!insertion.target) return;

  const flowId = mintId(byId, `Flow_${id}`);
  const flow = moddle.create('bpmn:SequenceFlow', { id: flowId });
  linkFlow(flow, element, insertion.target);
  flow.$parent = container;
  flowNodesOf(container).push(flow);
  byId.set(flowId, flow);
  changed.add(flowId);
  created.push(flowId);
}

// Lane membership lives on the lane, not on the node, so moving a node means editing two lanes.
function setLane({ definitions, byId, changed }, element, laneId) {
  for (const lane of walk(definitions)) {
    if (lane.$type !== 'bpmn:Lane' || !lane.flowNodeRef) continue;
    const at = lane.flowNodeRef.indexOf(element);
    if (at < 0) continue;
    lane.flowNodeRef.splice(at, 1);
    changed.add(lane.id);
  }
  if (laneId == null) return;

  const lane = byId.get(laneId);
  if (lane?.$type !== 'bpmn:Lane') throw new Error(`Lane "${laneId}" not found`);
  lane.flowNodeRef ??= [];
  lane.flowNodeRef.push(element);
  changed.add(lane.id);
}

function setElement(context, operation) {
  const { moddle, byId, changed } = context;
  const element = byId.get(operation.id);
  if (!element) throw new Error(`Element "${operation.id}" not found`);

  for (const [key, value] of Object.entries(operation.patch ?? {})) {
    if (key === 'if') {
      element.conditionExpression =
        value == null ? undefined : moddle.create('bpmn:FormalExpression', { body: value });
      if (element.conditionExpression) element.conditionExpression.$parent = element;
    } else if (key === 'default') {
      element.default = byId.get(value);
    } else if (key === 'lane') {
      setLane(context, element, value);
    } else if (key === 'to') {
      if (!element.$type.endsWith('Flow')) throw new Error(`Element "${operation.id}" is not a flow`);
      const target = byId.get(value);
      if (!target) throw new Error(`Target "${value}" not found`);
      retarget(element, target);
    } else {
      element[key] = value;
    }
  }
  changed.add(operation.id);
}

function deleteElement({ definitions, byId, changed }, operation) {
  const element = byId.get(operation.id);
  if (!element) throw new Error(`Element "${operation.id}" not found`);

  const container = element.$parent;
  const elements = [...walk(definitions)];
  const removed = new Set([element]);
  let foundAttachedElement;
  do {
    foundAttachedElement = false;
    for (const other of elements) {
      if (other.attachedToRef && removed.has(other.attachedToRef) && !removed.has(other)) {
        removed.add(other);
        foundAttachedElement = true;
      }
    }
  } while (foundAttachedElement);

  for (const other of elements) {
    if (
      other.$type === 'bpmn:SequenceFlow' &&
      (removed.has(other.sourceRef) || removed.has(other.targetRef))
    ) {
      removed.add(other);
    }
  }

  // Whatever a removed element contains goes with it — a task's inputOutputSpecification, its data
  // associations. Each one needs to be reported as changed and to have its DI dropped, or it
  // reads as collateral damage and leaves an edge pointing at nothing.
  const nested = [];
  for (const target of removed) {
    for (const child of contained(target)) nested.push(child);
  }
  for (const child of nested) removed.add(child);

  // DI is not a BPMN reference, so the XSD accepts a shape whose element is gone. Drop it here so
  // that "every element requiring DI has DI" also holds in reverse.
  for (const diagram of elements) {
    if (/^bpmndi:BPMN(Shape|Edge)$/.test(diagram.$type) && removed.has(diagram.bpmnElement)) {
      const siblings = diagram.$parent.planeElement;
      siblings.splice(siblings.indexOf(diagram), 1);
    }
  }

  for (const target of removed) {
    if (target.$type === 'bpmn:SequenceFlow') unlinkFlow(target);
    const siblings = target.$parent?.flowElements;
    if (siblings) {
      const position = siblings.indexOf(target);
      if (position >= 0) siblings.splice(position, 1);
    }
    for (const lane of walk(definitions)) {
      if (lane.$type !== 'bpmn:Lane' || !lane.flowNodeRef) continue;
      const position = lane.flowNodeRef.indexOf(target);
      if (position >= 0) lane.flowNodeRef.splice(position, 1);
    }
    byId.delete(target.id);
    changed.add(target.id);
  }
  if (container) changed.add(container.id);
}

function connectElements({ moddle, definitions, byId, changed, created }, operation) {
  const source = byId.get(operation.from);
  const target = byId.get(operation.to);
  if (!source) throw new Error(`Source "${operation.from}" not found`);
  if (!target) throw new Error(`Target "${operation.to}" not found`);

  // BPMN leaves no choice here: within a container a connection is a sequence flow, and across
  // one it can only be a message flow between pools of a collaboration.
  const crosses = containerOf(source) !== containerOf(target);
  const collaboration = crosses ? collaborationFor(definitions, source, target) : null;

  if (operation.remove) {
    const wanted = crosses ? 'bpmn:MessageFlow' : 'bpmn:SequenceFlow';
    for (const flow of walk(definitions)) {
      if (flow.$type !== wanted || flow.sourceRef !== source || flow.targetRef !== target) continue;
      unlinkFlow(flow);
      const siblings = flow.$parent?.flowElements ?? flow.$parent?.messageFlows;
      const position = siblings?.indexOf(flow) ?? -1;
      if (position >= 0) siblings.splice(position, 1);
      changed.add(flow.id);
    }
    return;
  }

  const id =
    operation.id && !byId.has(operation.id)
      ? operation.id
      : mintId(byId, `${crosses ? 'Message' : 'Flow'}_${operation.from}_${operation.to}`);
  const flow = moddle.create(crosses ? 'bpmn:MessageFlow' : 'bpmn:SequenceFlow', {
    id,
    ...(operation.name ? { name: operation.name } : {}),
  });
  linkFlow(flow, source, target);

  if (operation.if) {
    flow.conditionExpression = moddle.create('bpmn:FormalExpression', { body: operation.if });
    flow.conditionExpression.$parent = flow;
  }

  const container = collaboration ?? source.$parent;
  flow.$parent = container;
  if (collaboration) {
    collaboration.messageFlows ??= [];
    collaboration.messageFlows.push(flow);
  } else {
    flowNodesOf(container).push(flow);
  }
  byId.set(id, flow);
  changed.add(id);
  created.push(id);
}

function collaborationFor(definitions, source, target) {
  const scopes = new Set([containerOf(source), containerOf(target)]);
  for (const element of walk(definitions)) {
    if (element.$type !== 'bpmn:Collaboration') continue;
    // A black-box pool has no processRef, so it can hold no node to connect: it maps to
    // undefined and never matches a container.
    const pooled = new Set(element.participants.map((participant) => participant.processRef?.id));
    if ([...scopes].every((scope) => pooled.has(scope))) return element;
  }
  throw new Error(`"${source.id}" and "${target.id}" are not pools of one collaboration`);
}

export function applyPatch({ moddle, definitions }, operations) {
  const context = {
    moddle,
    definitions,
    byId: index(definitions),
    changed: new Set(),
    created: [],
  };

  for (const [at, operation] of operations.entries()) {
    try {
      switch (operation.op) {
        case 'add':
          addNode(context, operation);
          break;
        case 'set':
          setElement(context, operation);
          break;
        case 'del':
          deleteElement(context, operation);
          break;
        case 'connect':
          connectElements(context, operation);
          break;
        default:
          throw new Error(`Unknown operation "${operation.op}"`);
      }
    } catch (error) {
      // Which operation failed, so a caller can name it without re-running the plan.
      error.at ??= at;
      throw error;
    }
  }

  return { changed: [...context.changed], created: context.created };
}
