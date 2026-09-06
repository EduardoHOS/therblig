import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyPatch,
  diCoverage,
  insertAfter,
  placeNew,
  project,
  rename,
  risk,
  serialize,
  timeout,
} from '../../core/index.mjs';
import { fingerprint, scoreAll } from '../../../bench/scorer/gates.mjs';
import { normalizedFixture } from '../support/fixture.mjs';

// A hand-written IR: a straight line A → B → C, a gateway G with two exits, a timeout
// handler H, and a node Q that lives in another container.
const ir = () => ({
  processes: [{ id: 'P', name: 'P', executable: true }],
  nodes: [
    { id: 'A', type: 'task', name: 'Fetch score', in: 'P' },
    { id: 'B', type: 'user', name: 'Decide', in: 'P' },
    { id: 'C', type: 'end', name: 'Done', in: 'P' },
    { id: 'G', type: 'xor', in: 'P' },
    { id: 'H', type: 'task', name: 'Handle timeout', in: 'P' },
    { id: 'Q', type: 'task', name: 'Elsewhere', in: 'Sub' },
  ],
  flows: [
    { id: 'F1', from: 'A', to: 'B' },
    { id: 'F2', from: 'B', to: 'C' },
    { id: 'F3', from: 'G', to: 'B', if: '=ok' },
    { id: 'F4', from: 'G', to: 'C' },
  ],
});

const failsWith = (code, pattern) => (error) => {
  assert.equal(error.code, code);
  assert.match(error.message, pattern);
  return true;
};

test('insertAfter compiles to one add-between and an exact inverse', () => {
  const envelope = insertAfter(ir(), { anchor: 'A', step: { type: 'user', name: 'Review score' } });

  assert.deepEqual(envelope.plan, [
    { op: 'add', type: 'user', name: 'Review score', id: 'Review_score', in: 'P', between: ['A', 'B'] },
  ]);
  assert.deepEqual(envelope.inverse, [
    { op: 'set', id: 'F1', patch: { to: 'B' } },
    { op: 'del', id: 'Review_score' },
  ]);
  assert.deepEqual(envelope.minted, ['Review_score', 'Flow_Review_score']);
  assert.equal(envelope.risk, 'additive');
  assert.deepEqual(envelope.footprint, { cols: 1, rows: 0 });
  assert.equal(envelope.explain, 'Inserted "Review score" between "Fetch score" and "Decide".');
  assert.equal(envelope.op, 'insertAfter');
  assert.deepEqual(envelope.args, { anchor: 'A', step: { type: 'user', name: 'Review score' } });
});

test('insertAfter mints from the type when the step has no name and avoids taken ids', () => {
  const unnamed = insertAfter(ir(), { anchor: 'A', step: { type: 'user' } });
  assert.equal(unnamed.plan[0].id, 'user');
  assert.equal('name' in unnamed.plan[0], false);
  assert.equal(unnamed.explain, 'Inserted "user" between "Fetch score" and "Decide".');

  const collision = insertAfter(ir(), { anchor: 'A', step: { type: 'user', name: 'A' } });
  assert.equal(collision.plan[0].id, 'A_2');
  assert.deepEqual(collision.minted, ['A_2', 'Flow_A_2']);
});

test('insertAfter refuses an ambiguous anchor and names every exit', () => {
  assert.throws(
    () => insertAfter(ir(), { anchor: 'G', step: { type: 'user', name: 'X' } }),
    failsWith('anchor-ambiguous', /Anchor "G" has 2 outgoing flows — pass via: F3 \| F4/),
  );
});

test('insertAfter follows via on an ambiguous anchor', () => {
  const envelope = insertAfter(ir(), { anchor: 'G', step: { type: 'user', name: 'X' }, via: 'F4' });
  assert.deepEqual(envelope.plan[0].between, ['G', 'C']);
  assert.deepEqual(envelope.inverse[0], { op: 'set', id: 'F4', patch: { to: 'C' } });
  assert.deepEqual(envelope.args, { anchor: 'G', step: { type: 'user', name: 'X' }, via: 'F4' });
});

test('insertAfter preconditions name the element and the remedy', () => {
  const cases = [
    [{ anchor: 'G', step: { type: 'user' }, via: 'F1' }, 'via-not-outgoing', /Flow "F1" does not leave anchor "G"/],
    [{ anchor: 'C', step: { type: 'user' } }, 'anchor-no-outgoing', /Anchor "C" has no outgoing flow — use connect/],
    [{ anchor: 'Nope', step: { type: 'user' } }, 'element-not-found', /Node "Nope" not found/],
    [{ anchor: 'A', step: { type: 'wormhole' } }, 'unknown-node-type', /Unknown node type "wormhole"/],
    [{ anchor: 'A', step: { type: 'boundary' } }, 'step-not-insertable', /Step type "boundary" cannot be inserted/],
  ];
  for (const [args, code, pattern] of cases) {
    assert.throws(() => insertAfter(ir(), args), failsWith(code, pattern), code);
  }

  // The projection drops empty collections, so an IR with no flows has no `flows` key at all.
  assert.throws(
    () => insertAfter({ nodes: [{ id: 'A', type: 'task', in: 'P' }] }, { anchor: 'A', step: { type: 'user' } }),
    failsWith('anchor-no-outgoing', /Anchor "A" has no outgoing flow/),
  );
});

test('timeout compiles to a timer boundary plus its flow, and inverts by deleting the boundary', () => {
  const envelope = timeout(ir(), { on: 'B', after: 'P3D', to: 'H' });

  assert.deepEqual(envelope.plan, [
    { op: 'add', type: 'boundary', event: 'timer', on: 'B', in: 'P', id: 'B_timeout', timer: { duration: 'P3D' } },
    { op: 'connect', from: 'B_timeout', to: 'H', id: 'Flow_B_timeout' },
  ]);
  assert.deepEqual(envelope.inverse, [{ op: 'del', id: 'B_timeout' }]);
  assert.deepEqual(envelope.minted, ['B_timeout', 'Flow_B_timeout']);
  assert.equal(envelope.risk, 'additive');
  assert.deepEqual(envelope.footprint, { cols: 0, rows: 0 });
  assert.equal(envelope.explain, 'If "Decide" exceeds P3D, continue to "Handle timeout".');
});

test('timeout preconditions name the element and the remedy', () => {
  const cases = [
    [{ on: 'G', after: 'P3D', to: 'H' }, 'host-not-activity', /Host "G" is not an activity/],
    [{ on: 'B', after: 'P3D', to: 'Q' }, 'target-outside-container', /Target "Q" is outside the container of "B"/],
    [{ on: 'B', after: '3 days', to: 'H' }, 'invalid-duration', /Duration "3 days" is not ISO-8601/],
    [{ on: 'B', after: 'P3D', to: 'Nope' }, 'element-not-found', /Node "Nope" not found/],
    [{ on: 'Nope', after: 'P3D', to: 'H' }, 'element-not-found', /Node "Nope" not found/],
  ];
  for (const [args, code, pattern] of cases) {
    assert.throws(() => timeout(ir(), args), failsWith(code, pattern), code);
  }
});

test('rename compiles to one set and inverts to the previous name, including none', () => {
  const named = rename(ir(), { id: 'A', name: 'Fetch credit score' });
  assert.deepEqual(named.plan, [{ op: 'set', id: 'A', patch: { name: 'Fetch credit score' } }]);
  assert.deepEqual(named.inverse, [{ op: 'set', id: 'A', patch: { name: 'Fetch score' } }]);
  assert.deepEqual(named.minted, []);
  assert.equal(named.risk, 'safe');
  assert.deepEqual(named.footprint, { cols: 0, rows: 0 });
  assert.equal(named.explain, 'Renamed "Fetch score" to "Fetch credit score".');

  const unnamed = rename(ir(), { id: 'G', name: 'Approved?' });
  assert.deepEqual(unnamed.inverse, [{ op: 'set', id: 'G', patch: { name: null } }]);
  assert.equal(unnamed.explain, 'Renamed "G" to "Approved?".');

  const flow = rename(ir(), { id: 'F3', name: 'yes' });
  assert.deepEqual(flow.plan, [{ op: 'set', id: 'F3', patch: { name: 'yes' } }]);
});

test('rename preconditions name the element and the remedy', () => {
  assert.throws(
    () => rename(ir(), { id: 'Nope', name: 'x' }),
    failsWith('element-not-found', /Element "Nope" not found/),
  );
  for (const name of ['', '   ', 7, undefined]) {
    assert.throws(
      () => rename(ir(), { id: 'A', name }),
      failsWith('invalid-name', /Name must be a non-empty string/),
    );
  }
});

test('risk is computed from the plan, worst primitive wins', () => {
  assert.equal(risk([]), 'safe');
  assert.equal(risk([{ op: 'set', id: 'A', patch: { name: 'x' } }]), 'safe');
  assert.equal(risk([{ op: 'set', id: 'A' }]), 'safe');
  assert.equal(risk([{ op: 'add', type: 'user', in: 'P' }]), 'additive');
  assert.equal(risk([{ op: 'connect', from: 'A', to: 'B' }]), 'additive');
  assert.equal(risk([{ op: 'set', id: 'F1', patch: { if: '=x' } }]), 'routing');
  assert.equal(risk([{ op: 'set', id: 'G', patch: { default: 'F4' } }]), 'routing');
  assert.equal(risk([{ op: 'set', id: 'F1', patch: { to: 'C' } }]), 'routing');
  assert.equal(risk([{ op: 'connect', from: 'A', to: 'B', remove: true }]), 'destructive');
  assert.equal(risk([{ op: 'del', id: 'A' }]), 'destructive');
  assert.throws(() => risk([{ op: 'teleport' }]), /Unknown operation "teleport"/);
  assert.equal(
    risk([{ op: 'add', type: 'user', in: 'P' }, { op: 'set', id: 'F1', patch: { to: 'C' } }, { op: 'del', id: 'A' }]),
    'destructive',
  );
});

// --- integration: the real fixture through patch → placement → gates, then the inverse ---

test('rename on the fixture is a one-line diff with nothing moved, and inverts exactly', async () => {
  const { document, normalized } = await normalizedFixture();
  const envelope = rename(project(document.definitions), { id: 'Charge', name: 'Charge the card' });

  applyPatch(document, envelope.plan);
  const after = await serialize(document);
  const result = await scoreAll(normalized, after, { expectChangedIds: ['Charge'] });
  assert.equal(result.gates.noCollateral.ok, true);
  assert.equal(result.gates.diffSanity.addedLines, 1);
  assert.equal(result.gates.diffSanity.removedLines, 1);
  assert.equal(result.gates.diffSanity.shapesMoved, 0);

  applyPatch(document, envelope.inverse);
  assert.deepEqual(await fingerprint(await serialize(document)), await fingerprint(normalized));
});

test('timeout on the fixture places the boundary on its host and inverts without DI leftovers', async () => {
  const { document, normalized } = await normalizedFixture();
  const envelope = timeout(project(document.definitions), { on: 'Charge', after: 'P3D', to: 'Review' });

  applyPatch(document, envelope.plan);
  assert.deepEqual(placeNew(document, envelope.minted).placed, envelope.minted);
  assert.equal(diCoverage(document.definitions).ok, true);

  const after = await serialize(document);
  const result = await scoreAll(normalized, after, { expectChangedIds: envelope.minted });
  assert.equal(result.gates.xsdValid.ok, true);
  assert.equal(result.gates.lintClean.correctness.ok, true);
  assert.equal(result.gates.diffSanity.shapesMoved, 0);

  applyPatch(document, envelope.inverse);
  const restored = await serialize(document);
  assert.deepEqual(await fingerprint(restored), await fingerprint(normalized));
  for (const id of envelope.minted) assert.doesNotMatch(restored, new RegExp(`bpmnElement="${id}"`));
});

test('insertAfter on the fixture splices with rigid placement and inverts without DI leftovers', async () => {
  const { document, normalized } = await normalizedFixture();
  const envelope = insertAfter(project(document.definitions), {
    anchor: 'Charge',
    step: { type: 'user', name: 'Verify identity' },
  });

  applyPatch(document, envelope.plan);
  assert.deepEqual(placeNew(document, envelope.minted).placed, envelope.minted);
  assert.equal(diCoverage(document.definitions).ok, true);

  const after = await serialize(document);
  const result = await scoreAll(normalized, after, { expectChangedIds: [...envelope.minted, 'Flow_2'] });
  assert.equal(result.gates.xsdValid.ok, true);
  assert.equal(result.gates.lintClean.correctness.ok, true);
  assert.equal(result.gates.noCollateral.ok, true);
  assert.equal(result.gates.diffSanity.rigid, true);

  applyPatch(document, envelope.inverse);
  const restored = await serialize(document);
  assert.deepEqual(await fingerprint(restored), await fingerprint(normalized));
  for (const id of envelope.minted) assert.doesNotMatch(restored, new RegExp(`bpmnElement="${id}"`));
  assert.match(restored, /bpmnElement="Flow_2"/);
});

test('timeout and onError label their handler when given a name', () => {
  const named = timeout(ir(), { on: 'B', after: 'P3D', to: 'H', name: 'Too slow' });
  assert.equal(named.plan[0].name, 'Too slow');
  assert.equal(named.plan[0].id, 'B_timeout');

  const unnamed = timeout(ir(), { on: 'B', after: 'P3D', to: 'H' });
  assert.equal('name' in unnamed.plan[0], false);
});
