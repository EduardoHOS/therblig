import assert from 'node:assert/strict';
import { test } from 'node:test';

import { branch, parallel, project, propose } from '../../core/index.mjs';
import { normalizedFixture } from '../support/fixture.mjs';

const ir = () => ({
  processes: [{ id: 'P', name: 'P', executable: true }],
  nodes: [
    { id: 'A', type: 'task', name: 'Fetch', in: 'P' },
    { id: 'Z', type: 'end', name: 'Done', in: 'P' },
    { id: 'G', type: 'xor', name: 'Ok?', in: 'P' },
  ],
  flows: [
    { id: 'F1', from: 'A', to: 'Z' },
    { id: 'F2', from: 'G', to: 'Z' },
    { id: 'F3', from: 'G', to: 'A' },
  ],
});

const failsWith = (code, pattern) => (error) => {
  assert.equal(error.code, code);
  assert.match(error.message, pattern);
  return true;
};

test('branch mints a split and a join together and names both back', () => {
  const envelope = branch(ir(), {
    anchor: 'A',
    name: 'Approved?',
    label: 'yes',
    when: '=approved',
    yes: [{ type: 'user', name: 'Sign' }],
  });

  assert.deepEqual(envelope.result, { split: 'xor_split_A', join: 'xor_join_A' });
  // The original flow keeps its id and simply points at the split now.
  assert.deepEqual(envelope.plan, [
    { op: 'add', type: 'xor', name: 'Approved?', id: 'xor_split_A', in: 'P', between: ['A', 'Z'] },
    { op: 'add', type: 'xor', id: 'xor_join_A', in: 'P', between: ['xor_split_A', 'Z'] },
    { op: 'add', type: 'user', name: 'Sign', id: 'Sign', in: 'P' },
    { op: 'connect', from: 'xor_split_A', to: 'Sign', id: 'Flow_Sign_in', if: '=approved', name: 'yes' },
    { op: 'connect', from: 'Sign', to: 'xor_join_A', id: 'Flow_Sign_out' },
    { op: 'set', id: 'xor_split_A', patch: { default: 'Flow_xor_split_A' } },
  ]);
  assert.deepEqual(envelope.minted, [
    'xor_split_A',
    'Flow_xor_split_A',
    'xor_join_A',
    'Flow_xor_join_A',
    'Sign',
    'Flow_Sign_in',
    'Flow_Sign_out',
  ]);
  assert.equal(envelope.risk, 'routing');
  assert.deepEqual(envelope.footprint, { cols: 3, rows: 2 });
  assert.equal(
    envelope.explain,
    'After "Fetch", take "Sign" when =approved, and otherwise carry straight on; both rejoin before "Done".',
  );
  // The inverse deletes only the two gateways: `del` cascades everything hanging off them.
  assert.deepEqual(envelope.inverse, [
    { op: 'set', id: 'F1', patch: { to: 'Z' } },
    { op: 'del', id: 'xor_split_A' },
    { op: 'del', id: 'xor_join_A' },
  ]);
});

test('branch with a no-branch chains it instead of leaving the default bare', () => {
  const envelope = branch(ir(), {
    anchor: 'A',
    when: '=approved',
    yes: [{ type: 'user', name: 'Sign' }],
    no: [{ type: 'task', name: 'Reject' }, { type: 'send', name: 'Notify' }],
  });
  // No name and no label here: the op never invents them, so the gateway stays bare.
  assert.equal(envelope.plan[0].name, undefined);

  assert.deepEqual(envelope.plan.slice(2), [
    { op: 'add', type: 'task', name: 'Reject', id: 'Reject', in: 'P', between: ['xor_split_A', 'xor_join_A'] },
    { op: 'add', type: 'send', name: 'Notify', id: 'Notify', in: 'P', between: ['Reject', 'xor_join_A'] },
    { op: 'add', type: 'user', name: 'Sign', id: 'Sign', in: 'P' },
    { op: 'connect', from: 'xor_split_A', to: 'Sign', id: 'Flow_Sign_in', if: '=approved' },
    { op: 'connect', from: 'Sign', to: 'xor_join_A', id: 'Flow_Sign_out' },
    { op: 'set', id: 'xor_split_A', patch: { default: 'Flow_xor_split_A' } },
  ]);
  assert.deepEqual(envelope.footprint, { cols: 4, rows: 2 });
  assert.equal(
    envelope.explain,
    'After "Fetch", take "Sign" when =approved, and otherwise "Reject" then "Notify"; both rejoin before "Done".',
  );
});

test('parallel runs every branch and joins them all', () => {
  const envelope = parallel(ir(), {
    anchor: 'A',
    branches: [[{ type: 'service', name: 'Credit' }], [{ type: 'service', name: 'Fraud' }, { type: 'task', name: 'Log' }]],
  });

  assert.deepEqual(envelope.result, { split: 'and_split_A', join: 'and_join_A' });
  assert.deepEqual(envelope.plan.slice(0, 2), [
    { op: 'add', type: 'and', id: 'and_split_A', in: 'P', between: ['A', 'Z'] },
    { op: 'add', type: 'and', id: 'and_join_A', in: 'P', between: ['and_split_A', 'Z'] },
  ]);
  assert.deepEqual(envelope.plan.slice(2), [
    { op: 'add', type: 'service', name: 'Credit', id: 'Credit', in: 'P', between: ['and_split_A', 'and_join_A'] },
    { op: 'add', type: 'service', name: 'Fraud', id: 'Fraud', in: 'P' },
    { op: 'connect', from: 'and_split_A', to: 'Fraud', id: 'Flow_Fraud_in' },
    { op: 'add', type: 'task', name: 'Log', id: 'Log', in: 'P' },
    { op: 'connect', from: 'Fraud', to: 'Log', id: 'Flow_Log_in' },
    { op: 'connect', from: 'Log', to: 'and_join_A', id: 'Flow_Log_out' },
  ]);
  // No `set default`: a parallel split takes every branch, so a default would mean nothing.
  assert.equal(envelope.plan.some((operation) => operation.patch?.default), false);
  assert.deepEqual(envelope.footprint, { cols: 4, rows: 2 });
  assert.equal(
    envelope.explain,
    'After "Fetch", run "Credit" and "Fraud" then "Log" at the same time; all rejoin before "Done".',
  );
});

test('a fork refuses what it cannot balance', () => {
  const cases = [
    [parallel, { anchor: 'A', branches: [[{ type: 'task' }]] }, 'too-few-branches', /needs at least 2 branches — use insertAfter/],
    [parallel, { anchor: 'A', branches: [[{ type: 'task' }], []] }, 'empty-branch', /Branch 2 is empty/],
    [parallel, { anchor: 'G', branches: [[{ type: 'task' }], [{ type: 'task' }]] }, 'anchor-ambiguous', /pass via: F2 \| F3/],
    [branch, { anchor: 'A', when: '=x', yes: [] }, 'empty-branch', /The yes branch is empty/],
    [branch, { anchor: 'A', when: '=x', yes: [{ type: 'task' }], no: [] }, 'empty-branch', /Branch 1 is empty/],
    [branch, { anchor: 'A', yes: [{ type: 'task' }] }, 'missing-condition', /branch needs a condition/],
    [branch, { anchor: 'A', when: '=x', yes: [{ type: 'boundary' }] }, 'step-not-insertable', /cannot be inserted/],
  ];
  for (const [op, args, code, pattern] of cases) {
    assert.throws(() => op(ir(), args), failsWith(code, pattern), code);
  }
});

// --- integration: does a fork make room once, or reflow the diagram? ---

test('parallel on a real file opens room once and passes every gate', async () => {
  const { document } = await normalizedFixture();
  const envelope = parallel(project(document.definitions), {
    anchor: 'Charge',
    branches: [
      [{ type: 'service', name: 'Check credit' }],
      [{ type: 'service', name: 'Check fraud' }, { type: 'user', name: 'Record' }],
    ],
  });

  const result = await propose(document, envelope.plan);

  assert.equal(result.ok, true, JSON.stringify(result.gates.lintClean ?? result.gates));
  assert.deepEqual(result.created, envelope.minted);
  assert.deepEqual(result.placed.sort(), envelope.minted.slice().sort());
  assert.equal(result.gates.diCoverage.ok, true);
  // F9: making room is a rigid translation. A reflow scrambles the diagram into many deltas.
  assert.equal(result.diff.rigid, true, `deltas: ${result.diff.distinctDeltas}`);
});

test('branch on a real file opens room once and passes every gate', async () => {
  const { document } = await normalizedFixture('miwg/C.9.0.bpmn');
  const ir9 = project(document.definitions);
  const anchor = ir9.nodes.find(
    (node) => node.type === 'service' && ir9.flows.filter((flow) => flow.from === node.id).length === 1,
  );

  const envelope = branch(ir9, {
    anchor: anchor.id,
    name: 'Needs review?',
    label: 'yes',
    when: '=needsReview',
    yes: [{ type: 'user', name: 'Review score' }],
  });

  const result = await propose(document, envelope.plan);

  assert.equal(result.ok, true, JSON.stringify(result.gates.references?.introduced ?? result.gates.lintClean));
  assert.equal(result.gates.diCoverage.ok, true);
  assert.equal(result.diff.rigid, true, `deltas: ${result.diff.distinctDeltas}`);
});

test('a fork falls back to the type when a step carries no name', () => {
  const envelope = parallel(ir(), {
    anchor: 'A',
    branches: [[{ type: 'service' }], [{ type: 'manual' }]],
  });

  assert.deepEqual(envelope.plan[2], {
    op: 'add',
    type: 'service',
    id: 'service',
    in: 'P',
    between: ['and_split_A', 'and_join_A'],
  });
  assert.equal(envelope.plan[3].name, undefined);
  assert.equal(
    envelope.explain,
    'After "Fetch", run "service" and "manual" at the same time; all rejoin before "Done".',
  );
});
