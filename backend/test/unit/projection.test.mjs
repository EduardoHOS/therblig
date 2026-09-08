import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blocks } from '../../core/registry.mjs';
import { parse, project } from '../../core/index.mjs';
import { normalizedFixture, readFixture } from '../support/fixture.mjs';

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

test('each block projects the fields BPMN gives its own type, and only those', async () => {
  const core = await import('../../core/index.mjs');
  const document = await parse(await readFixture());
  core.applyPatch(document, [{ op: 'add', type: 'subprocess', in: 'Payment', id: 'Sub' }]);
  const byId = core.index(document.definitions);

  // An event carries kinds; an unknown vendor kind passes through under its BPMN type.
  byId.get('Start_1').eventDefinitions = [
    document.moddle.create('bpmn:TimerEventDefinition'),
    { $type: 'vendor:CustomEventDefinition' },
  ];
  // `default` belongs to activities and gateways alike.
  byId.get('Review').default = byId.get('Flow_3');
  byId.get('Sub').triggeredByEvent = true;
  // Properties BPMN does not give a user task: the projection must not invent them.
  byId.get('Review').eventDefinitions = [document.moddle.create('bpmn:TimerEventDefinition')];
  byId.get('Review').triggeredByEvent = true;

  const nodes = project(document.definitions).nodes;
  const node = (id) => nodes.find((candidate) => candidate.id === id);

  assert.deepEqual(node('Start_1').event, ['timer', 'vendor:CustomEventDefinition']);
  assert.equal(node('Review').default, 'Flow_3');
  assert.equal(node('Sub').eventSubprocess, true);

  assert.equal(node('Review').event, undefined);
  assert.equal(node('Review').eventSubprocess, undefined);
  assert.equal(node('Sub').default, undefined);
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

test('the artifacts a diagram carries are projected, without becoming addable node types', async () => {
  const { document } = await normalizedFixture('miwg/B.1.0.bpmn');
  const ir = project(document.definitions);

  const kinds = new Set((ir.data ?? []).map((item) => item.kind));
  assert.ok(kinds.has('object'), 'a data object reference');
  assert.ok(kinds.has('store'), 'a data store reference');
  assert.equal((ir.notes ?? []).length, 1, 'the text annotation');
  assert.equal((ir.groups ?? []).length, 1, 'the group');
  assert.ok((ir.links ?? []).length > 0, 'what the artifacts are associated with');

  // They are read, never written: the closed vocabulary is what `add` accepts, and an artifact is
  // not in it.
  const words = new Set(blocks.map((candidate) => candidate.ir));
  for (const item of ir.data ?? []) assert.equal(words.has(item.kind), false, item.kind);
  assert.equal((ir.nodes ?? []).some((node) => node.type === 'object'), false);
});
