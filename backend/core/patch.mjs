import { linkFlow, retarget, unlinkFlow } from './adjacency.mjs';
import { index, walk } from './document.mjs';
import { BPMN_EVENT_BY_KIND, BPMN_TYPE_BY_NODE } from './vocabulary.mjs';

export function mintId(byId, base) {
  const slug =
    String(base).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'Element';
  let id = slug;
  let suffix = 1;
  while (byId.has(id)) id = `${slug}_${++suffix}`;
  return id;
}

const TIMER_PROPERTY = { duration: 'timeDuration', cycle: 'timeCycle', date: 'timeDate' };

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
  const type = BPMN_TYPE_BY_NODE.get(operation.type);
  if (!type) throw new Error(`Unknown node type "${operation.type}"`);

  const container = byId.get(operation.in);
  if (!container) throw new Error(`Container "${operation.in}" not found`);
  const insertion = insertionFor(byId, container, operation);

  const id =
    operation.id && !byId.has(operation.id)
      ? operation.id
      : mintId(byId, operation.id || operation.name || operation.type);
  const element = moddle.create(type, {
    id,
    ...(operation.name ? { name: operation.name } : {}),
  });

  if (operation.event) {
    const definitionType = BPMN_EVENT_BY_KIND.get(operation.event);
    if (!definitionType) throw new Error(`Unknown event kind "${operation.event}"`);
    const definition = moddle.create(definitionType, {});
    definition.$parent = element;
    element.eventDefinitions = [definition];
  }

  if (operation.timer) {
    if (operation.event !== 'timer') throw new Error('Timer requires event "timer"');
    const given = Object.keys(TIMER_PROPERTY).filter((key) => operation.timer[key] != null);
    if (given.length !== 1) {
      throw new Error('Timer requires exactly one of duration, cycle, or date');
    }
    const [definition] = element.eventDefinitions;
    const expression = moddle.create('bpmn:FormalExpression', { body: operation.timer[given[0]] });
    expression.$parent = definition;
    definition[TIMER_PROPERTY[given[0]]] = expression;
  }

  if (operation.on) {
    const host = byId.get(operation.on);
    if (!host) throw new Error(`Boundary host "${operation.on}" not found`);
    element.attachedToRef = host;
    if (operation.interrupting === false) element.cancelActivity = false;
  }

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

function setElement({ moddle, byId, changed }, operation) {
  const element = byId.get(operation.id);
  if (!element) throw new Error(`Element "${operation.id}" not found`);

  for (const [key, value] of Object.entries(operation.patch ?? {})) {
    if (key === 'if') {
      element.conditionExpression =
        value == null ? undefined : moddle.create('bpmn:FormalExpression', { body: value });
      if (element.conditionExpression) element.conditionExpression.$parent = element;
    } else if (key === 'default') {
      element.default = byId.get(value);
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

  if (operation.remove) {
    for (const flow of walk(definitions)) {
      if (
        flow.$type !== 'bpmn:SequenceFlow' ||
        flow.sourceRef !== source ||
        flow.targetRef !== target
      ) {
        continue;
      }
      unlinkFlow(flow);
      const siblings = flow.$parent?.flowElements;
      if (siblings) {
        const position = siblings.indexOf(flow);
        if (position >= 0) siblings.splice(position, 1);
      }
      changed.add(flow.id);
    }
    return;
  }

  const container = source.$parent;
  const id =
    operation.id && !byId.has(operation.id)
      ? operation.id
      : mintId(byId, `Flow_${operation.from}_${operation.to}`);
  const flow = moddle.create('bpmn:SequenceFlow', {
    id,
    ...(operation.name ? { name: operation.name } : {}),
  });
  linkFlow(flow, source, target);

  if (operation.if) {
    flow.conditionExpression = moddle.create('bpmn:FormalExpression', { body: operation.if });
    flow.conditionExpression.$parent = flow;
  }

  flow.$parent = container;
  flowNodesOf(container).push(flow);
  byId.set(id, flow);
  changed.add(id);
  created.push(id);
}

export function applyPatch({ moddle, definitions }, operations) {
  const context = {
    moddle,
    definitions,
    byId: index(definitions),
    changed: new Set(),
    created: [],
  };

  for (const operation of operations) {
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
  }

  return { changed: [...context.changed], created: context.created };
}
