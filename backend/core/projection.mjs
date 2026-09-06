/**
 * The coordinate-free read projection an agent reasons over. Empty collections are dropped, so
 * every key is optional and every reader needs a fallback.
 *
 * @typedef {object} Projection
 * @property {IrProcess[]} [processes]
 * @property {IrNode[]} [nodes]
 * @property {IrFlow[]} [flows]
 * @property {IrLane[]} [lanes]
 * @property {IrPool[]} [pools]
 * @property {IrMessageFlow[]} [messageFlows]
 *
 * @typedef {object} IrProcess
 * @property {string} id
 * @property {string | null} name
 * @property {boolean | null} executable
 *
 * @typedef {object} IrNode
 * @property {string} id                      the original XML id, carried verbatim
 * @property {string} type                    an IR word from the block registry
 * @property {string} [name]
 * @property {string} [in]                    the container this node lives in
 * @property {string} [lane]
 * @property {string} [on]                    boundary events only: the host activity
 * @property {string | string[]} [event]      event blocks only: the kinds it carries
 * @property {string} [default]               gateways and activities only
 * @property {false} [interrupting]           boundary events only, when non-interrupting
 * @property {true} [eventSubprocess]
 * @property {string[]} [ext]                 vendor extension element types, unmodified
 *
 * @typedef {object} IrFlow
 * @property {string} id
 * @property {string} from
 * @property {string} to
 * @property {string} [name]
 * @property {string} [if]                    the condition expression body, as written
 *
 * @typedef {object} IrLane
 * @property {string} id
 * @property {string | null} name
 * @property {string | null} in
 *
 * @typedef {object} IrPool
 * @property {string} id
 * @property {string | null} name
 * @property {string | null} process
 *
 * @typedef {object} IrMessageFlow
 * @property {string} id
 * @property {string | null} name
 * @property {string} [from]
 * @property {string} [to]
 */

import { containerOf, walk } from './document.mjs';
import { byBpmn } from './registry.mjs';

function laneIndex(definitions) {
  const lanes = new Map();
  for (const element of walk(definitions)) {
    if (element.$type !== 'bpmn:Lane') continue;
    for (const reference of element.flowNodeRef || []) {
      if (reference?.id) lanes.set(reference.id, element.id);
    }
  }
  return lanes;
}

/** @param {unknown} definitions @param {{scope?: string | null}} [options] @returns {Projection} */
export function project(definitions, { scope = null } = {}) {
  const lanes = laneIndex(definitions);
  const projection = {
    processes: [],
    nodes: [],
    flows: [],
    lanes: [],
    pools: [],
    messageFlows: [],
  };

  for (const element of walk(definitions)) {
    const type = element.$type;
    if (type === 'bpmn:Process') {
      projection.processes.push({
        id: element.id,
        name: element.name ?? null,
        executable: element.isExecutable ?? null,
      });
    } else if (type === 'bpmn:Participant') {
      projection.pools.push({
        id: element.id,
        name: element.name ?? null,
        process: element.processRef?.id ?? null,
      });
    } else if (type === 'bpmn:Lane') {
      projection.lanes.push({ id: element.id, name: element.name ?? null, in: containerOf(element) });
    } else if (type === 'bpmn:MessageFlow') {
      projection.messageFlows.push({
        id: element.id,
        name: element.name ?? null,
        from: element.sourceRef?.id,
        to: element.targetRef?.id,
      });
    } else if (type === 'bpmn:SequenceFlow') {
      const flow = { id: element.id, from: element.sourceRef?.id, to: element.targetRef?.id };
      if (element.name) flow.name = element.name;
      if (element.conditionExpression?.body) flow.if = element.conditionExpression.body;
      projection.flows.push(flow);
    } else if (byBpmn.has(type)) {
      const definition = byBpmn.get(type);
      const node = { id: element.id, type: definition.ir };
      if (element.name) node.name = element.name;
      const container = containerOf(element);
      if (container) node.in = container;
      if (lanes.has(element.id)) node.lane = lanes.get(element.id);

      Object.assign(node, definition.project?.(element));
      if (element.extensionElements?.values?.length) {
        node.ext = element.extensionElements.values.map((value) => value.$type);
      }
      projection.nodes.push(node);
    }
  }

  if (scope) {
    const keep = new Set([
      scope,
      ...projection.nodes.filter((node) => node.in === scope).map((node) => node.id),
    ]);
    projection.nodes = projection.nodes.filter((node) => keep.has(node.id) || keep.has(node.on));
    const nodeIds = new Set(projection.nodes.map((node) => node.id));
    projection.flows = projection.flows.filter(
      (flow) => nodeIds.has(flow.from) && nodeIds.has(flow.to),
    );
  }

  for (const key of Object.keys(projection)) {
    if (!projection[key].length) delete projection[key];
  }
  return projection;
}
