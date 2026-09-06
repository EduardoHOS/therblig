import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyPatch,
  diCoverage,
  index,
  parse,
  placeNew,
  project,
  serialize,
  walk,
} from '../../core/index.mjs';
import { scoreAll } from '../../../bench/scorer/gates.mjs';
import { readFixture } from '../support/fixture.mjs';

const CASES = [
  ['handmade/zeebe-roundtrip.bpmn', 'Payment', 'Charge', 'Review'],
  ['miwg/C.9.1.bpmn'],
  ['miwg/C.9.0.bpmn'],
  ['miwg/A.1.0.bpmn'],
];

const MINIMAL_DI = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
  id="Definitions_1" targetNamespace="https://treadle.dev/test">
  <bpmn:process id="Process_1">
    <bpmn:task id="Task_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram_1">
    <bpmndi:BPMNPlane id="Plane_1" bpmnElement="Process_1" />
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

test('incremental placement keeps real diagrams valid and fully covered', async (context) => {
  for (const [file, configuredContainer, configuredSource, configuredTarget] of CASES) {
    await context.test(file, async () => {
      const document = await parse(await readFixture(file));
      const before = await serialize(document);
      assert.equal(diCoverage(document.definitions).ok, true);

      const projection = project(document.definitions);
      const nodes = new Map(projection.nodes.map((node) => [node.id, node]));
      const candidate = projection.flows.find(
        (flow) =>
          /task|user|service|manual|send|receive/.test(nodes.get(flow.from)?.type) &&
          nodes.has(flow.to),
      );
      const source = configuredSource ?? candidate.from;
      const target = configuredTarget ?? candidate.to;
      const container = configuredContainer ?? nodes.get(source).in;

      const { created } = applyPatch(document, [
        {
          op: 'add',
          type: 'user',
          name: 'Inserted step',
          in: container,
          id: 'TreadleInserted',
          between: [source, target],
        },
      ]);
      const touched = ['TreadleInserted', ...created];
      const placement = placeNew(document, touched);
      const after = await serialize(document);
      const score = await scoreAll(before, after, {
        expectChangedIds: [...touched, source],
      });

      assert.ok(placement.placed.length >= 2);
      assert.equal(diCoverage(document.definitions).ok, true);
      assert.equal(score.gates.xsdValid.ok, true);
      assert.equal(score.gates.lintClean.correctness.ok, true);
      assert.ok(score.gates.lintClean.styleDelta <= 0);
      assert.equal(score.gates.diffSanity.rigid, true);
    });
  }
});

test('placement reports a document with no diagram plane', async () => {
  const document = await parse(`<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_1" targetNamespace="https://treadle.dev/test">
  <process id="Process_1">
    <task id="Task_1" />
  </process>
</definitions>`);

  assert.deepEqual(placeNew(document, ['Task_1']), {
    placed: [],
    movedShapes: 0,
    reason: 'no BPMNPlane — file has no DI at all',
  });
  assert.deepEqual(diCoverage(document.definitions).missing, [
    { id: 'Task_1', type: 'bpmn:Task' },
  ]);
});

test('placement ignores unknown and already placed identifiers', async () => {
  const document = await parse(await readFixture());
  assert.deepEqual(placeNew(document, ['Nope', 'Charge']), { placed: [], movedShapes: 0 });
});

test('placement positions unanchored nodes with and without existing bounds', async () => {
  const existing = await parse(await readFixture());
  applyPatch(existing, [{ op: 'add', type: 'user', in: 'Payment', id: 'Unanchored' }]);
  assert.deepEqual(placeNew(existing, ['Unanchored']).placed, ['Unanchored']);

  const empty = await parse(MINIMAL_DI);
  assert.deepEqual(placeNew(empty, ['Task_1']).placed, ['Task_1']);
  const shape = [...walk(empty.definitions)].find(
    (element) => element.$type === 'bpmndi:BPMNShape' && element.bpmnElement?.id === 'Task_1',
  );
  assert.equal(shape.bounds.x, 150);
  assert.equal(shape.bounds.y, 80);
});

test('placement anchors nodes with only a predecessor or successor', async () => {
  const afterDocument = await parse(await readFixture());
  const afterPatch = applyPatch(afterDocument, [
    { op: 'add', type: 'user', in: 'Payment', id: 'Trailing' },
    { op: 'connect', from: 'End_1', to: 'Trailing', id: 'TrailingFlow' },
  ]);
  assert.deepEqual(placeNew(afterDocument, afterPatch.created).placed.sort(), [
    'Trailing',
    'TrailingFlow',
  ]);

  const beforeDocument = await parse(await readFixture());
  const beforePatch = applyPatch(beforeDocument, [
    { op: 'add', type: 'user', in: 'Payment', id: 'Leading' },
    { op: 'connect', from: 'Leading', to: 'Start_1', id: 'LeadingFlow' },
  ]);
  assert.deepEqual(placeNew(beforeDocument, beforePatch.created).placed.sort(), [
    'Leading',
    'LeadingFlow',
  ]);
});

test('placement docks boundary events and skips them when the host has no DI', async () => {
  const document = await parse(await readFixture());
  applyPatch(document, [
    { op: 'add', type: 'boundary', in: 'Payment', id: 'Timeout', on: 'Charge', event: 'timer' },
  ]);
  assert.deepEqual(placeNew(document, ['Timeout']).placed, ['Timeout']);

  const missingHostDiagram = await parse(MINIMAL_DI);
  applyPatch(missingHostDiagram, [
    {
      op: 'add',
      type: 'boundary',
      in: 'Process_1',
      id: 'MissingHostShape',
      on: 'Task_1',
      event: 'timer',
    },
  ]);
  assert.deepEqual(placeNew(missingHostDiagram, ['MissingHostShape']).placed, []);
});

test('placement expands a new subprocess containing real children', async () => {
  const document = await parse(await readFixture());
  applyPatch(document, [
    { op: 'add', type: 'subprocess', in: 'Payment', id: 'Subprocess' },
    { op: 'add', type: 'user', in: 'Subprocess', id: 'InnerTask' },
  ]);

  assert.deepEqual(placeNew(document, ['Subprocess', 'InnerTask']).placed, [
    'Subprocess',
    'InnerTask',
  ]);
  const subprocessShape = [...walk(document.definitions)].find(
    (element) =>
      element.$type === 'bpmndi:BPMNShape' && element.bpmnElement?.id === 'Subprocess',
  );
  assert.equal(subprocessShape.isExpanded, true);
  assert.equal(index(document.definitions).get('InnerTask').$parent.id, 'Subprocess');
});

test('placement skips an edge until both endpoint shapes exist', async () => {
  const document = await parse(MINIMAL_DI);
  const result = applyPatch(document, [
    { op: 'add', type: 'user', in: 'Process_1', id: 'Task_2' },
    { op: 'connect', from: 'Task_1', to: 'Task_2', id: 'Flow_1' },
  ]);

  assert.deepEqual(placeNew(document, [result.created.at(-1)]).placed, []);
});

test('placement routes a vertical edge through orthogonal waypoints', async () => {
  const document = await parse(await readFixture());
  const reviewShape = [...walk(document.definitions)].find(
    (element) =>
      element.$type === 'bpmndi:BPMNShape' && element.bpmnElement?.id === 'Review',
  );
  reviewShape.bounds.y += 120;
  applyPatch(document, [
    { op: 'connect', from: 'Charge', to: 'Review', id: 'VerticalFlow' },
  ]);

  assert.deepEqual(placeNew(document, ['VerticalFlow']).placed, ['VerticalFlow']);
  const edge = [...walk(document.definitions)].find(
    (element) =>
      element.$type === 'bpmndi:BPMNEdge' && element.bpmnElement?.id === 'VerticalFlow',
  );
  assert.equal(edge.waypoint.length, 4);
});
