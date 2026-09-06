import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parse, project } from '../../core/index.mjs';
import { readFixture } from '../support/fixture.mjs';

test('project creates a compact coordinate-free view with original identifiers', async () => {
  const document = await parse(await readFixture());
  const projection = project(document.definitions);

  assert.equal(projection.nodes.length, 4);
  assert.equal(projection.flows.length, 3);
  assert.ok(projection.flows.every((flow) => flow.from && flow.to));
  assert.equal(projection.nodes.find((node) => node.id === 'Charge').type, 'service');
  assert.equal(projection.nodes.find((node) => node.id === 'Review').type, 'user');
  assert.ok(
    projection.nodes.find((node) => node.id === 'Charge').ext.includes('zeebe:taskDefinition'),
  );
  assert.equal(JSON.stringify(projection).includes('Bounds'), false);
  assert.equal(JSON.stringify(projection).includes('"x"'), false);
});

test('project scopes nodes and flows to one container', async () => {
  const document = await parse(await readFixture());
  const projection = project(document.definitions, { scope: 'Payment' });

  assert.ok(projection.nodes.length > 0);
  assert.ok(projection.nodes.every((node) => node.in === 'Payment'));
  const nodeIds = new Set(projection.nodes.map((node) => node.id));
  assert.ok(projection.flows.every((flow) => nodeIds.has(flow.from) && nodeIds.has(flow.to)));
});

test('project represents defaults, multiple events, and event subprocesses', async () => {
  const document = await parse(await readFixture());
  const byId = new Map();
  for (const element of (await import('../../core/index.mjs')).walk(document.definitions)) {
    if (element.id) byId.set(element.id, element);
  }

  const review = byId.get('Review');
  review.eventDefinitions = [
    document.moddle.create('bpmn:TimerEventDefinition'),
    { $type: 'vendor:CustomEventDefinition' },
  ];
  review.default = byId.get('Flow_3');
  review.triggeredByEvent = true;

  const node = project(document.definitions).nodes.find((candidate) => candidate.id === 'Review');
  assert.deepEqual(node.event, ['timer', 'vendor:CustomEventDefinition']);
  assert.equal(node.default, 'Flow_3');
  assert.equal(node.eventSubprocess, true);
});

test('project preserves intentionally unresolved collaboration references', () => {
  const participant = { $type: 'bpmn:Participant', id: 'Pool_1' };
  const messageFlow = { $type: 'bpmn:MessageFlow', id: 'Message_1' };
  const collaboration = {
    $type: 'bpmn:Collaboration',
    id: 'Collaboration_1',
    participants: [participant],
    messageFlows: [messageFlow],
  };
  participant.$parent = collaboration;
  messageFlow.$parent = collaboration;
  const definitions = {
    $type: 'bpmn:Definitions',
    id: 'Definitions_1',
    rootElements: [collaboration],
  };

  assert.deepEqual(project(definitions), {
    pools: [{ id: 'Pool_1', name: null, process: null }],
    messageFlows: [
      { id: 'Message_1', name: null, from: undefined, to: undefined },
    ],
  });
});

test('project tolerates empty lane membership and indexes valid lane references', () => {
  const process = { $type: 'bpmn:Process', id: 'Process_1', flowElements: [], laneSets: [] };
  const task = { $type: 'bpmn:Task', id: 'Task_1', $parent: process };
  const emptyLane = { $type: 'bpmn:Lane', id: 'Lane_Empty', $parent: process };
  const populatedLane = {
    $type: 'bpmn:Lane',
    id: 'Lane_Populated',
    flowNodeRef: [{}, task],
    $parent: process,
  };
  process.flowElements.push(task);
  process.laneSets.push({
    $type: 'bpmn:LaneSet',
    id: 'LaneSet_1',
    lanes: [emptyLane, populatedLane],
    $parent: process,
  });

  const projection = project({
    $type: 'bpmn:Definitions',
    id: 'Definitions_1',
    rootElements: [process],
  });

  assert.equal(projection.lanes.length, 2);
  assert.equal(projection.nodes[0].lane, 'Lane_Populated');
});

test('scoped projection retains an attached event even when its container differs', () => {
  const process = { $type: 'bpmn:Process', id: 'Process_1', flowElements: [] };
  const otherProcess = { $type: 'bpmn:Process', id: 'Process_2', flowElements: [] };
  const host = { $type: 'bpmn:Task', id: 'Host', $parent: process };
  const attached = {
    $type: 'bpmn:BoundaryEvent',
    id: 'Attached',
    attachedToRef: host,
    $parent: otherProcess,
  };
  const outsider = { $type: 'bpmn:Task', id: 'Outsider', $parent: otherProcess };
  process.flowElements.push(host);
  otherProcess.flowElements.push(attached, outsider);

  const projection = project(
    {
      $type: 'bpmn:Definitions',
      id: 'Definitions_1',
      rootElements: [process, otherProcess],
    },
    { scope: 'Process_1' },
  );

  assert.deepEqual(
    projection.nodes.map((node) => node.id),
    ['Host', 'Attached'],
  );
});
