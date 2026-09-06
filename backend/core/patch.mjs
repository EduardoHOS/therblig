import { linkFlow, retarget, unlinkFlow } from './adjacency.mjs';
import { index, walk } from './document.mjs';
import { pruneDI } from './placement.mjs';
import { BPMN_EVENT_BY_KIND, BPMN_TYPE_BY_NODE } from './vocabulary.mjs';

function mintId(byId, base) {
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

  // flowNodesOf, not container.flowElements: a container that holds nothing yet has no
  // flowElements array at all, and reading .filter off it throws. Reached on C.8.0,
  // where the splice anchor's container is empty — found by the corpus sweep rather
  // than by a fixture, because a fixture built to be edited always has contents.
  const existingFlows = flowNodesOf(container).filter(
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

// What `set` may write. Closed on purpose. The open `element[key] = value` fallthrough it
// replaces assigned any key straight onto the moddle object, so a caller could put an id
// string where an element reference belongs — `set {targetRef: 'X'}` serialized
// targetRef="undefined", a silently corrupted graph that passed every gate — or a plain
// string where a typed child collection belongs, which threw at serialize time, after the
// edit had already been applied. See docs/FINDINGS.md F12.
//
// `if`, `default` and `documentation` are handled separately because each needs a typed
// construction rather than an assignment.
const SETTABLE = new Set([
  'name',
  'if',
  'default',
  'documentation',
  'isExecutable',
  'isForCompensation',
  'isInterrupting',
  'cancelActivity',
  'triggeredByEvent',
  'completionQuantity',
  'startQuantity',
]);

// Refused with an explanation rather than silently mangled. The graph references belong
// to adjacency.mjs — the architecture test enforces that for core modules, and this
// enforces it for a caller's operations, which the test cannot see. `id` is refused
// because a renamed id breaks every reference to it and the human is looking at the old
// one in their modeller.
const FORBIDDEN = new Set([
  'sourceRef',
  'targetRef',
  'incoming',
  'outgoing',
  'attachedToRef',
  'flowNodeRef',
  'id',
  '$type',
  '$parent',
]);

function setElement({ moddle, byId, changed }, operation) {
  const element = byId.get(operation.id);
  if (!element) throw new Error(`Element "${operation.id}" not found`);

  for (const [key, value] of Object.entries(operation.patch ?? {})) {
    if (key === 'if') {
      element.conditionExpression =
        value == null ? undefined : moddle.create('bpmn:FormalExpression', { body: value });
      if (element.conditionExpression) element.conditionExpression.$parent = element;
    } else if (key === 'default') {
      const target = byId.get(value);
      if (value != null && !target) throw new Error(`Default flow "${value}" not found`);
      element.default = target;
    } else if (key === 'documentation') {
      // bpmn:Documentation is a typed child collection, not a string attribute.
      if (value == null || value === '') {
        element.documentation = undefined;
      } else {
        const documentation = moddle.create('bpmn:Documentation', { text: String(value) });
        documentation.$parent = element;
        element.documentation = [documentation];
      }
    } else if (FORBIDDEN.has(key)) {
      throw new Error(
        `"${key}" cannot be set directly — adjacency is recorded on both the flow and its ` +
          'endpoints, and writing one side corrupts the graph. Use connect, move or del.',
      );
    } else if (!SETTABLE.has(key)) {
      throw new Error(
        `"${key}" is not settable. Allowed: ${[...SETTABLE].sort().join(', ')}.`,
      );
    } else {
      element[key] = value;
    }
  }
  changed.add(operation.id);
}

/**
 * Move a node into another lane.
 *
 * Lane membership is a list of flowNodeRef on the bpmn:Lane, not a property of the node,
 * which is why `set {patch:{lane}}` had nothing to write. It is two edits — one lane
 * loses the reference, another gains it — and doing half leaves the node listed twice or
 * not at all.
 */
function moveElement({ definitions, byId, changed }, operation) {
  const element = byId.get(operation.id);
  if (!element) throw new Error(`Element "${operation.id}" not found`);
  if (typeof operation.lane !== 'string') throw new Error('move needs a "lane" to move into');

  const lane = byId.get(operation.lane);
  if (!lane) throw new Error(`Lane "${operation.lane}" not found`);
  if (lane.$type !== 'bpmn:Lane') {
    throw new Error(`"${operation.lane}" is a ${lane.$type.replace('bpmn:', '')}, not a lane`);
  }

  for (const candidate of walk(definitions)) {
    if (candidate.$type !== 'bpmn:Lane' || !candidate.flowNodeRef) continue;
    const position = candidate.flowNodeRef.indexOf(element);
    if (position >= 0 && candidate !== lane) {
      candidate.flowNodeRef.splice(position, 1);
      changed.add(candidate.id);
    }
  }

  lane.flowNodeRef ??= [];
  if (!lane.flowNodeRef.includes(element)) lane.flowNodeRef.push(element);
  changed.add(lane.id);
  changed.add(element.id);
}

/**
 * Connect two nodes across a pool boundary.
 *
 * Only a message flow may cross one, and it belongs to the bpmn:Collaboration rather than
 * to either process. Different parent, different collection, and no part in node
 * adjacency — `incoming`/`outgoing` hold sequence flows only. Three structural
 * differences, which is why this is a verb and not a flag on connect.
 */
function messageElements({ moddle, definitions, byId, changed, created }, operation) {
  const source = byId.get(operation.from);
  const target = byId.get(operation.to);
  if (!source) throw new Error(`Source "${operation.from}" not found`);
  if (!target) throw new Error(`Target "${operation.to}" not found`);

  let collaboration = null;
  for (const candidate of walk(definitions)) {
    if (candidate.$type === 'bpmn:Collaboration') { collaboration = candidate; break; }
  }
  if (!collaboration) {
    throw new Error('This file has no collaboration, so it has no pools for a message flow to cross');
  }

  const id =
    operation.id && !byId.has(operation.id)
      ? operation.id
      : mintId(byId, `Message_${operation.from}_${operation.to}`);
  const flow = moddle.create('bpmn:MessageFlow', {
    id,
    sourceRef: source,
    targetRef: target,
    ...(operation.name ? { name: operation.name } : {}),
  });
  flow.$parent = collaboration;
  collaboration.messageFlows ??= [];
  collaboration.messageFlows.push(flow);
  byId.set(id, flow);
  changed.add(id);
  created.push(id);
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
      case 'move':
        moveElement(context, operation);
        break;
      case 'message':
        messageElements(context, operation);
        break;
      default:
        throw new Error(`Unknown operation "${operation.op}"`);
    }
  }

  // Semantics and diagram are one document. `del` used to remove an element and leave
  // its shape on the plane pointing at nothing — a file that still parses, still
  // validates, and that coverage called fully covered because it only asked one
  // direction. Pruning here rather than inside `del` makes it structural: no operation,
  // present or future, can leave orphaned DI behind. See docs/FINDINGS.md F12.
  const prunedDI = pruneDI(definitions);

  return { changed: [...context.changed], created: context.created, prunedDI };
}
