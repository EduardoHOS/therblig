import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPatch, index, project, serialize } from '../../core/index.mjs';
import { scoreAll } from '../../../bench/scorer/gates.mjs';
import { normalizedFixture } from '../support/fixture.mjs';

test('set changes one requested attribute without collateral edits', async () => {
  const { document, normalized } = await normalizedFixture();
  applyPatch(document, [{ op: 'set', id: 'Charge', patch: { name: 'Charge the card' } }]);

  const result = await scoreAll(normalized, await serialize(document), {
    expectChangedIds: ['Charge'],
  });
  assert.equal(result.gates.noCollateral.ok, true);
  assert.equal(result.gates.diffSanity.addedLines, 1);
  assert.equal(result.gates.diffSanity.shapesMoved, 0);
  assert.equal(result.gates.xsdValid.ok, true);
  assert.equal(result.gates.lintClean.correctness.ok, true);
});

test('add splices a node while maintaining both sides of adjacency', async () => {
  const { document, normalized } = await normalizedFixture();
  const { created } = applyPatch(document, [
    {
      op: 'add',
      type: 'user',
      name: 'Verify identity',
      in: 'Payment',
      id: 'Verify',
      between: ['Charge', 'Review'],
    },
  ]);

  const byId = index(document.definitions);
  const inserted = byId.get('Verify');
  assert.equal(inserted.incoming[0].sourceRef.id, 'Charge');
  assert.equal(inserted.outgoing[0].targetRef.id, 'Review');
  assert.ok(byId.get('Charge').outgoing.includes(inserted.incoming[0]));
  assert.ok(byId.get('Review').incoming.includes(inserted.outgoing[0]));

  const projection = project(document.definitions);
  assert.ok(projection.nodes.some((node) => node.id === 'Verify' && node.type === 'user'));
  assert.ok(projection.flows.some((flow) => flow.from === 'Charge' && flow.to === 'Verify'));
  assert.ok(projection.flows.some((flow) => flow.from === 'Verify' && flow.to === 'Review'));

  const result = await scoreAll(normalized, await serialize(document), {
    expectChangedIds: [...created, 'Verify', 'Flow_2'],
  });
  assert.equal(result.gates.xsdValid.ok, true);
  assert.equal(result.gates.lintClean.correctness.ok, true);
  assert.equal(result.gates.diffSanity.shapesMoved, 0);
});

test('add creates a non-interrupting boundary event', async () => {
  const { document } = await normalizedFixture();
  applyPatch(document, [
    {
      op: 'add',
      type: 'boundary',
      name: 'Timeout',
      in: 'Payment',
      id: 'Timeout',
      on: 'Charge',
      event: 'timer',
      interrupting: false,
    },
  ]);

  const boundary = project(document.definitions).nodes.find((node) => node.id === 'Timeout');
  assert.equal(boundary.on, 'Charge');
  assert.equal(boundary.event, 'timer');
  assert.equal(boundary.interrupting, false);
});

test('delete cascades through flows and attached boundary events', async () => {
  const { document } = await normalizedFixture();
  applyPatch(document, [
    { op: 'add', type: 'boundary', in: 'Payment', id: 'Timeout', on: 'Review', event: 'timer' },
    { op: 'connect', from: 'Timeout', to: 'End_1', id: 'TimeoutFlow' },
    { op: 'del', id: 'Review' },
  ]);

  const projection = project(document.definitions);
  assert.equal(projection.nodes.some((node) => node.id === 'Review'), false);
  assert.equal(projection.nodes.some((node) => node.id === 'Timeout'), false);
  assert.equal(
    projection.flows.some(
      (flow) =>
        flow.from === 'Review' ||
        flow.to === 'Review' ||
        flow.from === 'Timeout' ||
        flow.to === 'Timeout',
    ),
    false,
  );
});

test('connect creates and removes a conditional flow', async () => {
  const { document } = await normalizedFixture();
  applyPatch(document, [
    { op: 'add', type: 'xor', name: 'Charge ok?', in: 'Payment', id: 'Ok' },
    {
      op: 'connect',
      from: 'Ok',
      to: 'End_1',
      if: '=charged = false',
      name: 'declined',
    },
  ]);

  let conditional = project(document.definitions).flows.find(
    (flow) => flow.from === 'Ok' && flow.to === 'End_1',
  );
  assert.equal(conditional.if, '=charged = false');
  assert.equal(conditional.name, 'declined');

  applyPatch(document, [{ op: 'connect', from: 'Ok', to: 'End_1', remove: true }]);
  conditional = project(document.definitions).flows.find(
    (flow) => flow.from === 'Ok' && flow.to === 'End_1',
  );
  assert.equal(conditional, undefined);
});

test('set creates, removes, and references structured flow properties', async () => {
  const { document } = await normalizedFixture();
  applyPatch(document, [
    { op: 'set', id: 'Flow_2', patch: { if: '=approved' } },
    { op: 'add', type: 'xor', in: 'Payment', id: 'Decision' },
    { op: 'connect', from: 'Decision', to: 'End_1', id: 'Fallback' },
    { op: 'set', id: 'Decision', patch: { default: 'Fallback' } },
  ]);

  let projection = project(document.definitions);
  assert.equal(projection.flows.find((flow) => flow.id === 'Flow_2').if, '=approved');
  assert.equal(projection.nodes.find((node) => node.id === 'Decision').default, 'Fallback');

  applyPatch(document, [{ op: 'set', id: 'Flow_2', patch: { if: null } }]);
  projection = project(document.definitions);
  assert.equal(projection.flows.find((flow) => flow.id === 'Flow_2').if, undefined);
});

test('add mints stable unique identifiers and supports after without a successor', async () => {
  const { document } = await normalizedFixture();
  const result = applyPatch(document, [
    { op: 'add', type: 'user', in: 'Payment', id: 'Charge' },
    { op: 'add', type: 'user', in: 'Payment', name: '!!!' },
    { op: 'add', type: 'user', in: 'Payment', id: 'Trailing', after: 'End_1' },
  ]);

  assert.deepEqual(result.created, ['Charge_2', 'Element', 'Trailing']);
  assert.ok(result.changed.includes('Charge_2'));
  assert.ok(result.changed.includes('Element'));
  assert.ok(result.changed.includes('Trailing'));
});

test('add after an existing flow inserts before its current target', async () => {
  const { document } = await normalizedFixture();
  applyPatch(document, [
    { op: 'add', type: 'user', in: 'Payment', id: 'AfterCharge', after: 'Charge' },
  ]);

  const projection = project(document.definitions);
  assert.ok(
    projection.flows.some((flow) => flow.from === 'Charge' && flow.to === 'AfterCharge'),
  );
  assert.ok(
    projection.flows.some((flow) => flow.from === 'AfterCharge' && flow.to === 'Review'),
  );
});

test('set accepts an omitted patch as an explicit no-op', async () => {
  const { document } = await normalizedFixture();
  assert.deepEqual(applyPatch(document, [{ op: 'set', id: 'Charge' }]).changed, ['Charge']);
});

test('connect respects a unique requested id and mints on collision', async () => {
  const { document } = await normalizedFixture();
  const result = applyPatch(document, [
    { op: 'connect', from: 'Start_1', to: 'End_1', id: 'RequestedFlow' },
    { op: 'connect', from: 'Start_1', to: 'End_1', id: 'RequestedFlow' },
  ]);

  assert.deepEqual(result.created, ['RequestedFlow', 'Flow_Start_1_End_1']);
});

test('delete removes a node from its lane membership', async () => {
  const { document } = await normalizedFixture('miwg/C.4.0.bpmn');
  const projection = project(document.definitions);
  const node = projection.nodes.find((candidate) => candidate.lane);
  const lane = index(document.definitions).get(node.lane);
  const removed = index(document.definitions).get(node.id);
  assert.ok(lane.flowNodeRef.includes(removed));

  applyPatch(document, [{ op: 'del', id: node.id }]);

  assert.equal(lane.flowNodeRef.includes(removed), false);
});

test('patch failures identify the invalid input', async () => {
  const cases = [
    [{ op: 'set', id: 'Nope', patch: { name: 'x' } }, /Element "Nope" not found/],
    [{ op: 'add', type: 'wormhole', in: 'Payment' }, /Unknown node type "wormhole"/],
    [{ op: 'add', type: 'user', in: 'Nope' }, /Container "Nope" not found/],
    [
      { op: 'add', type: 'boundary', in: 'Payment', on: 'Nope' },
      /Boundary host "Nope" not found/,
    ],
    [{ op: 'add', type: 'boundary', in: 'Payment', event: 'teleport' }, /Unknown event kind/],
    [{ op: 'connect', from: 'Nope', to: 'End_1' }, /Source "Nope" not found/],
    [{ op: 'connect', from: 'Charge', to: 'Nope' }, /Target "Nope" not found/],
    [{ op: 'del', id: 'Nope' }, /Element "Nope" not found/],
    [
      { op: 'add', type: 'user', in: 'Payment', after: 'Nope' },
      /Node "Nope" not found/,
    ],
    [{ op: 'teleport' }, /Unknown operation "teleport"/],
  ];

  for (const [operation, expected] of cases) {
    const { document } = await normalizedFixture();
    assert.throws(() => applyPatch(document, [operation]), expected);
  }
});

test('a rejected add leaves the document unchanged', async () => {
  const invalidOperations = [
    { op: 'add', type: 'user', in: 'Payment', id: 'InvalidAfter', after: 'Nope' },
    {
      op: 'add',
      type: 'user',
      in: 'Payment',
      id: 'InvalidBetween',
      between: ['Charge', 'Nope'],
    },
  ];

  for (const operation of invalidOperations) {
    const { document } = await normalizedFixture();
    const before = await serialize(document);

    assert.throws(() => applyPatch(document, [operation]), /Node "Nope" not found/);
    assert.equal(await serialize(document), before);
  }
});

test('add sets a timer duration on the timer event definition', async () => {
  const { document, normalized } = await normalizedFixture();
  applyPatch(document, [
    {
      op: 'add',
      type: 'boundary',
      in: 'Payment',
      id: 'Timeout',
      on: 'Charge',
      event: 'timer',
      timer: { duration: 'P3D' },
    },
  ]);

  const timer = index(document.definitions).get('Timeout').eventDefinitions[0];
  assert.equal(timer.timeDuration.body, 'P3D');

  const result = await scoreAll(normalized, await serialize(document), {
    expectChangedIds: ['Timeout'],
  });
  assert.equal(result.gates.xsdValid.ok, true);
});

test('add refuses a timer that is not exactly one of duration, cycle, or date', async () => {
  const cases = [
    [{ event: 'timer', timer: {} }, /Timer requires exactly one of duration, cycle, or date/],
    [
      { event: 'timer', timer: { duration: 'P1D', cycle: 'R/PT1H' } },
      /Timer requires exactly one of duration, cycle, or date/,
    ],
    [{ event: 'message', timer: { duration: 'P1D' } }, /Timer requires event "timer"/],
  ];

  for (const [extra, expected] of cases) {
    const { document } = await normalizedFixture();
    assert.throws(
      () =>
        applyPatch(document, [
          { op: 'add', type: 'boundary', in: 'Payment', on: 'Charge', ...extra },
        ]),
      expected,
    );
  }
});

test('set to retargets a flow through adjacency', async () => {
  const { document } = await normalizedFixture();
  applyPatch(document, [{ op: 'set', id: 'Flow_2', patch: { to: 'End_1' } }]);

  const byId = index(document.definitions);
  const flow = byId.get('Flow_2');
  assert.equal(flow.targetRef.id, 'End_1');
  assert.ok(byId.get('End_1').incoming.includes(flow));
  assert.equal(byId.get('Review').incoming.includes(flow), false);

  assert.throws(
    () => applyPatch(document, [{ op: 'set', id: 'Flow_2', patch: { to: 'Nope' } }]),
    /Target "Nope" not found/,
  );
  assert.throws(
    () => applyPatch(document, [{ op: 'set', id: 'Charge', patch: { to: 'End_1' } }]),
    /Element "Charge" is not a flow/,
  );
});

test('set null removes an attribute instead of writing "null"', async () => {
  const { document } = await normalizedFixture();
  applyPatch(document, [{ op: 'set', id: 'Charge', patch: { name: null } }]);

  assert.equal(project(document.definitions).nodes.find((node) => node.id === 'Charge').name, undefined);
  assert.doesNotMatch(await serialize(document), /name="null"/);
});

test('delete removes the DI of every removed element', async () => {
  const { document } = await normalizedFixture();
  applyPatch(document, [{ op: 'del', id: 'Review' }]);

  const xml = await serialize(document);
  for (const id of ['Review', 'Flow_2', 'Flow_3']) {
    assert.doesNotMatch(xml, new RegExp(`bpmnElement="${id}"`), `${id} still has DI`);
  }
});
