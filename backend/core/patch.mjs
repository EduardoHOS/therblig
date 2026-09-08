/**
 * The four primitives emitted by intent operations. Their union stays closed; the file API
 * also accepts the separately typed move and message verbs.
 *
 * @typedef {AddOperation | SetOperation | DelOperation | ConnectOperation} Operation
 *
 * @typedef {object} AddOperation
 * @property {'add'} op
 * @property {string} type                    an IR word from the block registry
 * @property {string} in                      the container to add into
 * @property {string} [id]                    minted when absent or already taken
 * @property {string} [name]
 * @property {string} [event]                 event blocks only
 * @property {{duration?: string, cycle?: string, date?: string}} [timer]
 * @property {string} [on]                    boundary events only: the host
 * @property {boolean} [interrupting]
 * @property {string} [after]                 splice after this node
 * @property {[string, string]} [between]     splice between these two, retargeting the flow
 *
 * @typedef {object} SetOperation
 * @property {'set'} op
 * @property {string} id
 * @property {Record<string, unknown>} [patch]  `if`, `default`, `to` and `lane` are structural
 *
 * @typedef {object} DelOperation
 * @property {'del'} op
 * @property {string} id
 *
 * @typedef {object} ConnectOperation
 * @property {'connect'} op
 * @property {string} from
 * @property {string} to
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [if]
 * @property {boolean} [remove]
 *
 * @typedef {object} PatchResult
 * @property {string[]} changed
 * @property {string[]} created
 * @property {string[]} prunedDI
 *
 * Legacy file API verbs coexist with the four primitives emitted by intent operations.
 * @typedef {{op: 'move', id: string, lane: string} | {op: 'message', from: string, to: string, id?: string, name?: string}} LegacyOperation
 */

import { linkFlow, retarget, unlinkFlow } from './adjacency.mjs';
import { contained, containerOf, index, walk } from './document.mjs';
import { block } from './registry.mjs';
import { pruneDI } from './placement.mjs';

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
  'lane',
  'to',
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
      const target = byId.get(value);
      if (value != null && !target) throw new Error(`Default flow "${value}" not found`);
      element.default = target;
    } else if (key === 'lane') {
      setLane(context, element, value);
    } else if (key === 'to') {
      if (!element.$type.endsWith('Flow')) throw new Error(`Element "${operation.id}" is not a flow`);
      const target = byId.get(value);
      if (!target) throw new Error(`Target "${value}" not found`);
      retarget(element, target);
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
    ...(operation.name ? { name: operation.name } : {}),
  });
  linkFlow(flow, source, target);
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
      /^bpmn:(SequenceFlow|MessageFlow)$/.test(other.$type) &&
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

  for (const target of removed) {
    if (/^bpmn:(SequenceFlow|MessageFlow)$/.test(target.$type)) unlinkFlow(target);
    const siblings = target.$parent?.flowElements ?? target.$parent?.messageFlows;
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

function connectElements({ moddle, definitions, byId, changed, created, inferMessageFlows }, operation) {
  const source = byId.get(operation.from);
  const target = byId.get(operation.to);
  if (!source) throw new Error(`Source "${operation.from}" not found`);
  if (!target) throw new Error(`Target "${operation.to}" not found`);

  // Intent plans infer message flows between pools. The file API preserves explicit sequence
  // connections so its oracle can reject a cross-pool sequence flow as requested.
  const crosses = inferMessageFlows && containerOf(source) !== containerOf(target);
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

/**
 * @param {{moddle: unknown, definitions: unknown}} document
 * @param {(Operation | LegacyOperation)[]} operations
 * @param {{inferMessageFlows?: boolean}} [options] false preserves explicit sequence connections for oracle validation
 * @returns {PatchResult}
 */
export function applyPatch({ moddle, definitions }, operations, { inferMessageFlows = true } = {}) {
  const context = {
    moddle,
    definitions,
    byId: index(definitions),
    changed: new Set(),
    created: [],
    inferMessageFlows,
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
        case 'move':
          moveElement(context, operation);
          break;
        case 'message':
          messageElements(context, operation);
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

  // Semantics and diagram are one document. `del` used to remove an element and leave
  // its shape on the plane pointing at nothing — a file that still parses, still
  // validates, and that coverage called fully covered because it only asked one
  // direction. Pruning here rather than inside `del` makes it structural: no operation,
  // present or future, can leave orphaned DI behind. See docs/FINDINGS.md F12.
  const prunedDI = pruneDI(definitions);

  return { changed: [...context.changed], created: context.created, prunedDI };
}
