/**
 * @typedef {object} Seed
 * @property {{moddle: unknown, definitions: unknown}} document
 * @property {{definitions: string, process: string, start: string, end: string, flow: string}} ids
 */

import { BpmnModdle } from 'bpmn-moddle';

import { applyPatch, mintId } from './patch.mjs';
import { placeNew } from './placement.mjs';

// The namespace Camunda Modeler writes; the XSD gate accepts it and nothing downstream reads it.
const NAMESPACE = 'http://bpmn.io/schema/bpmn';

function refuse(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * The smallest process worth growing: a start and an end, connected, with DI for all three.
 *
 * Nothing but these three elements is ever generated from nothing. The nodes and the flow go in
 * through `applyPatch`, so they are built, linked and minted exactly as an op's plan would be; the
 * plane is created empty and `placeNew` draws into it, which is incremental placement and not a
 * layouter. Every later change goes through the ops with their gates, inverse and risk.
 *
 * @param {{name: string, start?: string, end?: string, executable?: boolean}} [args]
 * @returns {Seed}
 */
export function seed({ name, start = 'Start', end = 'End', executable = false } = {}) {
  const title = typeof name === 'string' ? name.trim() : '';
  if (!title) throw refuse('invalid-name', 'A process needs a name — pass a non-empty name');

  const taken = new Set();
  const mint = (hint) => {
    const id = mintId(taken, hint);
    taken.add(id);
    return id;
  };
  const ids = {
    definitions: mint(`Definitions_${title}`),
    process: mint(`Process_${title}`),
    start: mint(start),
    end: mint(end),
  };
  ids.flow = mint(`Flow_${ids.start}`);

  const moddle = new BpmnModdle();
  const process = moddle.create('bpmn:Process', {
    id: ids.process,
    name: title,
    isExecutable: executable,
    flowElements: [],
  });
  const definitions = moddle.create('bpmn:Definitions', {
    id: ids.definitions,
    targetNamespace: NAMESPACE,
    rootElements: [process],
  });
  process.$parent = definitions;

  const plane = moddle.create('bpmndi:BPMNPlane', {
    id: mint(`Plane_${title}`),
    bpmnElement: process,
    planeElement: [],
  });
  const diagram = moddle.create('bpmndi:BPMNDiagram', { id: mint(`Diagram_${title}`), plane });
  plane.$parent = diagram;
  diagram.$parent = definitions;
  definitions.diagrams = [diagram];

  const document = { moddle, definitions };
  applyPatch(document, [
    { op: 'add', type: 'start', in: ids.process, id: ids.start, name: start },
    { op: 'add', type: 'end', in: ids.process, id: ids.end, name: end },
    { op: 'connect', from: ids.start, to: ids.end, id: ids.flow },
  ]);
  placeNew(document, [ids.start, ids.end, ids.flow]);

  return { document, ids };
}
