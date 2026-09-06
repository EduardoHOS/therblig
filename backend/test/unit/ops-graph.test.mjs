import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyPatch,
  bypass,
  guard,
  message,
  moveToLane,
  onError,
  project,
  propose,
  risk,
  walk,
} from '../../core/index.mjs';
import { normalizedFixture } from '../support/fixture.mjs';

// A → B → C with a boundary on B, a gateway G with two exits, and two pools joined by a
// collaboration: enough graph for every op below to have both its happy path and its refusal.
const ir = () => ({
  processes: [
    { id: 'P', name: 'Sales', executable: true },
    { id: 'P2', name: 'Ops', executable: true },
  ],
  pools: [
    { id: 'Pool_1', name: 'Sales', process: 'P' },
    { id: 'Pool_2', name: 'Ops', process: 'P2' },
  ],
  lanes: [
    { id: 'L1', name: 'Front desk', in: 'P' },
    { id: 'L2', name: 'Back office', in: 'P' },
    { id: 'L3', name: 'Ops team', in: 'P2' },
  ],
  nodes: [
    { id: 'A', type: 'task', name: 'Receive', in: 'P', lane: 'L1' },
    { id: 'B', type: 'user', name: 'Check', in: 'P', lane: 'L1' },
    { id: 'C', type: 'end', name: 'Done', in: 'P' },
    { id: 'G', type: 'xor', name: 'Ok?', in: 'P' },
    { id: 'H', type: 'task', name: 'Escalate', in: 'P' },
    { id: 'Bnd', type: 'boundary', name: 'Late', in: 'P', on: 'B', event: 'timer' },
    { id: 'X', type: 'task', name: 'Fulfil', in: 'P2', lane: 'L3' },
  ],
  flows: [
    { id: 'F1', from: 'A', to: 'B' },
    { id: 'F2', from: 'B', to: 'C' },
    { id: 'F3', from: 'G', to: 'C', if: '=ok' },
    { id: 'F4', from: 'G', to: 'H' },
    { id: 'F5', from: 'Bnd', to: 'H' },
  ],
});

const failsWith = (code, pattern) => (error) => {
  assert.equal(error.code, code);
  assert.match(error.message, pattern);
  return true;
};

test('bypass heals the chain through the surviving flow and restores both on inverse', () => {
  const clean = ir();
  clean.nodes = clean.nodes.filter((node) => node.id !== 'Bnd');
  clean.flows = clean.flows.filter((flow) => flow.id !== 'F5');
  const envelope = bypass(clean, { id: 'B' });

  assert.deepEqual(envelope.plan, [
    { op: 'set', id: 'F1', patch: { to: 'C' } },
    { op: 'del', id: 'B' },
  ]);
  assert.deepEqual(envelope.inverse, [
    { op: 'add', type: 'user', name: 'Check', id: 'B', in: 'P' },
    { op: 'set', id: 'F1', patch: { to: 'B' } },
    { op: 'connect', from: 'B', to: 'C', id: 'F2' },
  ]);
  assert.deepEqual(envelope.minted, []);
  assert.equal(envelope.risk, 'destructive');
  // del cascades the outgoing flow too; the envelope says so rather than letting it surprise.
  assert.deepEqual(envelope.removes, ['B', 'F2']);
  assert.equal(envelope.explain, 'Removed "Check"; "Receive" now continues to "Done".');
});

test('bypass refuses a node whose healing would be a guess', () => {
  const cases = [
    [{ id: 'G' }, 'heal-ambiguous', /Node "G" has 0 incoming and 2 outgoing flows/],
    [{ id: 'C' }, 'heal-ambiguous', /Node "C" has 2 incoming and 0 outgoing flows/],
    [{ id: 'Nope' }, 'element-not-found', /Node "Nope" not found/],
  ];
  for (const [args, code, pattern] of cases) {
    assert.throws(() => bypass(ir(), args), failsWith(code, pattern), code);
  }
});

test('onError mirrors timeout with an error boundary that catches anything', () => {
  const envelope = onError(ir(), { on: 'B', to: 'H' });

  assert.deepEqual(envelope.plan, [
    { op: 'add', type: 'boundary', event: 'error', on: 'B', in: 'P', id: 'B_error' },
    { op: 'connect', from: 'B_error', to: 'H', id: 'Flow_B_error' },
  ]);
  assert.equal(
    onError(ir(), { on: 'B', to: 'H', name: 'Failed' }).plan[0].name,
    'Failed',
  );
  assert.deepEqual(envelope.inverse, [{ op: 'del', id: 'B_error' }]);
  assert.equal(envelope.risk, 'additive');
  assert.equal(envelope.explain, 'If "Check" fails, continue to "Escalate".');

  for (const [args, code] of [
    [{ on: 'G', to: 'H' }, 'host-not-activity'],
    [{ on: 'B', to: 'X' }, 'target-outside-container'],
  ]) {
    assert.throws(() => onError(ir(), args), (error) => error.code === code, code);
  }
});

test('moveToLane changes who does the work, and inverts to the lane it left', () => {
  const moved = moveToLane(ir(), { id: 'B', lane: 'L2' });
  assert.deepEqual(moved.plan, [{ op: 'set', id: 'B', patch: { lane: 'L2' } }]);
  assert.deepEqual(moved.inverse, [{ op: 'set', id: 'B', patch: { lane: 'L1' } }]);
  assert.equal(moved.risk, 'routing');
  assert.equal(moved.explain, 'Moved "Check" from "Front desk" to "Back office".');

  const fromNoLane = moveToLane(ir(), { id: 'H', lane: 'L2' });
  assert.deepEqual(fromNoLane.inverse, [{ op: 'set', id: 'H', patch: { lane: null } }]);
  assert.equal(fromNoLane.explain, 'Moved "Escalate" into "Back office".');
});

test('moveToLane refuses a lane in another pool — that is a message, not a move', () => {
  assert.throws(
    () => moveToLane(ir(), { id: 'B', lane: 'L3' }),
    failsWith('lane-in-another-pool', /Lane "L3" is not in the container of "B" — use message/),
  );
  assert.throws(
    () => moveToLane(ir(), { id: 'B', lane: 'A' }),
    failsWith('not-a-lane', /Element "A" is not a lane/),
  );
});

test('guard sets a condition or a default, never both, and only on a gateway exit', () => {
  const conditioned = guard(ir(), { flow: 'F4', if: '=escalate' });
  assert.deepEqual(conditioned.plan, [{ op: 'set', id: 'F4', patch: { if: '=escalate' } }]);
  assert.deepEqual(conditioned.inverse, [{ op: 'set', id: 'F4', patch: { if: null } }]);
  assert.equal(conditioned.risk, 'routing');
  assert.equal(conditioned.explain, 'From "Ok?", take "F4" when =escalate.');

  const defaulted = guard(ir(), { flow: 'F4', default: true });
  assert.deepEqual(defaulted.plan, [{ op: 'set', id: 'G', patch: { default: 'F4' } }]);
  assert.deepEqual(defaulted.inverse, [{ op: 'set', id: 'G', patch: { default: null } }]);
  assert.equal(defaulted.explain, 'From "Ok?", take "F4" when nothing else applies.');

  const replacing = guard(ir(), { flow: 'F3', if: '=other' });
  assert.deepEqual(replacing.inverse, [{ op: 'set', id: 'F3', patch: { if: '=ok' } }]);

  const cases = [
    [{ flow: 'F1', if: '=x' }, 'condition-ignored', /Flow "F1" does not leave a gateway/],
    [{ flow: 'F4' }, 'guard-underspecified', /Pass exactly one of if or default/],
    [{ flow: 'F4', if: '=x', default: true }, 'guard-underspecified', /Pass exactly one of if or default/],
    [{ flow: 'B', if: '=x' }, 'not-a-flow', /Element "B" is not a flow/],
  ];
  for (const [args, code, pattern] of cases) {
    assert.throws(() => guard(ir(), args), failsWith(code, pattern), code);
  }
});

test('message connects across pools, which is the only connection allowed to', () => {
  const envelope = message(ir(), { from: 'B', to: 'X', name: 'order' });

  assert.deepEqual(envelope.plan, [
    { op: 'connect', from: 'B', to: 'X', id: 'Message_B_X', name: 'order' },
  ]);
  assert.deepEqual(envelope.inverse, [{ op: 'connect', from: 'B', to: 'X', remove: true }]);
  assert.deepEqual(envelope.minted, ['Message_B_X']);
  assert.equal(envelope.risk, 'additive');
  assert.equal(envelope.explain, 'Sales sends "order" from "Check" to "Fulfil" in Ops.');

  assert.throws(
    () => message(ir(), { from: 'A', to: 'B' }),
    failsWith('same-container', /"A" and "B" are in the same container — use insertAfter/),
  );
});

test('risk knows that lane membership decides who executes, not just what is named', () => {
  assert.equal(risk([{ op: 'set', id: 'B', patch: { lane: 'L2' } }]), 'routing');
  assert.equal(risk([{ op: 'set', id: 'B', patch: { name: 'x' } }]), 'safe');
});

// --- integration: the real collaboration fixture through propose ---

const C40 = {
  node: '_aa275782-c989-49ba-bf94-c58916ca7bb5',
  incoming: '_237c8380-5449-446e-a323-aad80181176d',
  successor: '_305ddf53-49a8-4105-ad06-70272a2332aa',
  laneA: '_ff7ff8f6-a4f1-4e93-84e1-01cdb85eb755',
  laneB: '_937b5086-463f-4c8c-837d-f5eee5cbc1f4',
  gateway: '_f9e3cd76-809a-48b5-be1c-e84fc4324268',
  gatewayExit: '_7e9d8b8b-faa9-4264-858b-7454702c4ec2',
  otherPoolNode: '_7e9d2e5a-21f7-493b-9ae4-03245aa33a5c',
};

test('bypass refuses a node with a boundary event, because the inverse would be lossy', () => {
  assert.throws(
    () => bypass(ir(), { id: 'B', force: true }),
    failsWith('has-boundary', /Node "B" carries boundary events \(Bnd\) — remove them first, or use del/),
  );
});

test('bypass on the real fixture heals the chain and passes every gate', async () => {
  const { document } = await normalizedFixture('miwg/C.4.0.bpmn');
  const envelope = bypass(project(document.definitions), { id: C40.node });

  const result = await propose(document, envelope.plan);

  assert.equal(result.ok, true, JSON.stringify(result.gates.references?.introduced));
  assert.match(result.xml, new RegExp(`id="${C40.incoming}"[^>]*targetRef="${C40.successor}"`));
  assert.doesNotMatch(result.xml, new RegExp(`bpmnElement="${C40.node}"`));
});

test('moveToLane on the real fixture moves the node between lanes of one pool', async () => {
  const { document } = await normalizedFixture('miwg/C.4.0.bpmn');
  const envelope = moveToLane(project(document.definitions), {
    id: C40.node,
    lane: C40.laneB,
  });

  const result = await propose(document, envelope.plan);

  assert.equal(result.ok, true);
  const moved = project((await parseXml(result.xml)).definitions).nodes.find(
    (node) => node.id === C40.node,
  );
  assert.equal(moved.lane, C40.laneB);
});

test('message refuses pools that share no collaboration to live in', async () => {
  const { document } = await normalizedFixture('miwg/C.4.0.bpmn');
  const envelope = message(project(document.definitions), {
    from: C40.node,
    to: C40.otherPoolNode,
  });

  // C.4.0 gives every pool its own single-participant collaboration, so there is no one place a
  // message flow between these two could live. Guessing one would put it in an arbitrary parent.
  await assert.rejects(propose(document, envelope.plan), /are not pools of one collaboration/);
});

test('message on a real two-pool collaboration mints a message flow and draws it', async () => {
  const { document } = await normalizedFixture('miwg/C.1.0.bpmn');
  const from = 'sid-05039C4F-59F7-4CBD-8C84-D35E27C7B5EF';
  const to = 'approveInvoice';
  const envelope = message(project(document.definitions), { from, to, name: 'scanned invoice' });

  const result = await propose(document, envelope.plan);

  assert.equal(result.gates.lintClean.correctness.ok, true);
  assert.equal(result.gates.references.ok, true);
  assert.equal(result.gates.xsdValid.ok, true);
  assert.deepEqual(result.created, envelope.minted);
  assert.deepEqual(result.placed, envelope.minted);

  const flows = project((await parseXml(result.xml)).definitions).messageFlows;
  assert.ok(flows.some((flow) => flow.from === from && flow.to === to && flow.name === 'scanned invoice'));
  assert.equal(
    envelope.explain,
    'Team-Assistant sends "scanned invoice" from "Scan Invoice" to "Approve Invoice" in Process Engine - Invoice Receipt.',
  );

  // The one style regression is bpmnlint's `no-implicit-split` counting the new message flow as
  // a second outgoing branch. BPMN does not: a message flow carries no token. The gate reports
  // it rather than special-casing a linter rule, and `recommended` is a style opinion (ADR-006).
  assert.equal(result.gates.lintClean.styleDelta, 1);
  assert.equal(result.ok, false);
});

test('guarding one exit alone introduces the style error bpmnlint names', async () => {
  const { document } = await normalizedFixture('miwg/C.4.0.bpmn');
  const envelope = guard(project(document.definitions), { flow: C40.gatewayExit, if: '=rejected' });

  const result = await propose(document, envelope.plan);

  assert.equal(result.gates.lintClean.correctness.ok, true);
  assert.equal(result.gates.lintClean.styleDelta, 1);
  assert.equal(result.ok, false);
});

test('guard on the real fixture conditions one exit and defaults the other', async () => {
  const { document } = await normalizedFixture('miwg/C.4.0.bpmn');
  const ir = project(document.definitions);
  const conditioned = guard(ir, { flow: C40.gatewayExit, if: '=rejected' });
  const defaulted = guard(ir, { flow: C40.incoming, default: true });

  const result = await propose(document, [...conditioned.plan, ...defaulted.plan]);

  assert.equal(result.ok, true, JSON.stringify(result.gates.lintClean));
  const after = project((await parseXml(result.xml)).definitions);
  assert.equal(after.flows.find((flow) => flow.id === C40.gatewayExit).if, '=rejected');
  assert.equal(after.nodes.find((node) => node.id === C40.gateway).default, C40.incoming);
});

async function parseXml(xml) {
  const { parse } = await import('../../core/index.mjs');
  return parse(xml);
}

test('applying moveToLane and then its inverse leaves lane membership as it was', async () => {
  const { document } = await normalizedFixture('miwg/C.4.0.bpmn');
  const envelope = moveToLane(project(document.definitions), { id: C40.node, lane: C40.laneB });
  const laneOf = (ir) => ir.nodes.find((node) => node.id === C40.node).lane;

  applyPatch(document, envelope.plan);
  assert.equal(laneOf(project(document.definitions)), C40.laneB);

  applyPatch(document, envelope.inverse);
  assert.equal(laneOf(project(document.definitions)), C40.laneA);
});

test('set lane clears membership when given null, and refuses anything that is not a lane', async () => {
  const { document } = await normalizedFixture('miwg/C.4.0.bpmn');

  applyPatch(document, [{ op: 'set', id: C40.node, patch: { lane: null } }]);
  assert.equal(
    project(document.definitions).nodes.find((node) => node.id === C40.node).lane,
    undefined,
  );

  for (const lane of ['Nope', C40.node]) {
    assert.throws(
      () => applyPatch(document, [{ op: 'set', id: C40.node, patch: { lane } }]),
      new RegExp(`Lane "${lane}" not found`),
    );
  }
});

test('bypass carries an unnamed node through its inverse without inventing a name', () => {
  const unnamed = ir();
  unnamed.nodes = unnamed.nodes.filter((node) => node.id !== 'Bnd');
  unnamed.flows = unnamed.flows.filter((flow) => flow.id !== 'F5');
  delete unnamed.nodes.find((node) => node.id === 'B').name;

  const envelope = bypass(unnamed, { id: 'B' });
  assert.deepEqual(envelope.inverse[0], { op: 'add', type: 'user', id: 'B', in: 'P' });
  assert.equal(envelope.explain, 'Removed "B"; "Receive" now continues to "Done".');
});

test('a black-box pool holds no node, so it can never be one end of a message', async () => {
  const { document } = await normalizedFixture('miwg/C.1.0.bpmn');
  const collaboration = [...walk(document.definitions)].find(
    (element) => element.$type === 'bpmn:Collaboration',
  );
  for (const participant of collaboration.participants) delete participant.processRef;

  assert.throws(
    () =>
      applyPatch(document, [
        { op: 'connect', from: 'sid-05039C4F-59F7-4CBD-8C84-D35E27C7B5EF', to: 'approveInvoice' },
      ]),
    /are not pools of one collaboration/,
  );
});

test('message names the container when a process has no pool to name it', () => {
  const poolless = ir();
  delete poolless.pools;

  assert.equal(
    message(poolless, { from: 'B', to: 'X' }).explain,
    'P sends from "Check" to "Fulfil" in P2.',
  );
});
