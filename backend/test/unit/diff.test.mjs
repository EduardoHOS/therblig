import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPatch, diff, parse, placeNew, project, review, serialize } from '../../core/index.mjs';
import { normalizedFixture, readFixture } from '../support/fixture.mjs';

async function edited(operations, fixture) {
  const { document, normalized } = await normalizedFixture(fixture);
  const { created } = applyPatch(document, operations);
  placeNew(document, created);
  return { before: normalized, after: await serialize(document) };
}

test('a rename is a rename, not a removal and an addition', async () => {
  const { before, after } = await edited([{ op: 'set', id: 'Charge', patch: { name: 'Charge the card' } }]);

  const result = await diff(before, after);

  assert.deepEqual(result.renamed, [{ id: 'Charge', from: 'Charge card', to: 'Charge the card' }]);
  for (const key of ['added', 'removed', 'rerouted', 'retyped', 'reowned']) {
    assert.deepEqual(result[key], [], key);
  }
  assert.equal(result.shapesMoved, 0);
});

test('an insertion is reported as what was added and what was rerouted, by id', async () => {
  const { before, after } = await edited([
    { op: 'add', type: 'user', name: 'Verify', id: 'Verify', in: 'Payment', between: ['Charge', 'Review'] },
  ]);

  const result = await diff(before, after);

  assert.deepEqual(
    result.added.map((entry) => entry.id).sort(),
    ['Flow_Verify', 'Verify'],
  );
  assert.deepEqual(result.rerouted, [{ id: 'Flow_2', from: 'Charge', to: 'Verify', was: 'Review' }]);
  assert.deepEqual(result.removed, []);
});

test('a lane move is reported as a change of owner, not of anything else', async () => {
  const node = '_aa275782-c989-49ba-bf94-c58916ca7bb5';
  const { before, after } = await edited(
    [{ op: 'set', id: node, patch: { lane: '_937b5086-463f-4c8c-837d-f5eee5cbc1f4' } }],
    'miwg/C.4.0.bpmn',
  );

  const result = await diff(before, after);

  assert.deepEqual(result.reowned, [
    { id: node, from: 'HR Department', to: 'Responsible Department' },
  ]);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.renamed, []);
});

test('a deletion names what went with it', async () => {
  const { before, after } = await edited([{ op: 'del', id: 'Review' }]);

  const result = await diff(before, after);

  assert.deepEqual(result.removed.map((entry) => entry.id).sort(), ['Flow_2', 'Flow_3', 'Review']);
  assert.deepEqual(result.added, []);
});

// The packet is what a reviewer reads, so it has to say what changed, why, and what it costs —
// and to be silent about cost when it does not know.
test('the review packet refuses to put a number on a model with no durations', async () => {
  const { before, after } = await edited([
    { op: 'add', type: 'user', name: 'Verify', id: 'Verify', in: 'Payment', between: ['Charge', 'Review'] },
  ]);

  const packet = await review(before, after, { explain: ['Inserted "Verify" between two steps.'] });
  const fromOp = await review(before, after, { level: 'additive' });
  assert.match(fromOp, /risk +additive$/m, 'an op passes the level it computed');

  assert.match(packet, /^# Review/m);
  assert.match(packet, /Inserted "Verify" between two steps\./);
  assert.match(packet, /added.*Verify/is);
  assert.match(packet, /rerouted.*Flow_2/is);
  assert.match(packet, /risk +routing \(derived from the diff/i, 'an insertion reroutes a flow');
  assert.doesNotMatch(packet, /noCollateral/, 'collateral needs an intent this has no way to know');
  assert.match(packet, /no estimate/i);
  assert.match(packet, /treadle:duration/, 'it says what would let it estimate');
  assert.doesNotMatch(packet, /p50 \d/, 'and reports no cycle time of its own');
});

test('the review packet reports a cycle-time delta when both sides carry durations', async () => {
  const before = await readFixture('handmade/parallel-join.bpmn');
  const document = await parse(before);
  const ir = project(document.definitions);
  const fraud = ir.nodes.find((node) => node.id === 'Fraud');
  assert.ok(fraud);

  // Halve the nine-hour branch, which is the one the join waits for.
  const after = before.replace('<treadle:duration p50="PT9H" />', '<treadle:duration p50="PT4H" />');

  const packet = await review(before, after, { when: { '=covered': true } });

  assert.match(packet, /p50/);
  assert.match(packet, /10h → 5h/);
  assert.doesNotMatch(packet, /no estimate/i);
});

test('the packet says which gate failed rather than only that one did', async () => {
  const before = await readFixture();
  const packet = await review(before, before.replace('Charge card', ''), {});

  assert.match(packet, /gates/i);
  assert.match(packet, /lintClean|label-required/i);
});

test('a retype, a new message flow, and a move out of every lane are each named', async () => {
  const before = await readFixture('miwg/C.1.0.bpmn');
  const document = await parse(before);
  const ir = project(document.definitions);
  // C.1.0 has an unnamed lane, so pick a node from one that has a name and check the other case
  // through the packet instead.
  const named = ir.lanes.find((lane) => lane.name?.trim());
  const laned = ir.nodes.find((node) => node.lane === named.id);
  const scan = 'sid-05039C4F-59F7-4CBD-8C84-D35E27C7B5EF';

  applyPatch(document, [
    { op: 'connect', from: scan, to: 'approveInvoice', id: 'Msg_new', name: 'scanned' },
    { op: 'set', id: laned.id, patch: { lane: null } },
  ]);
  // A retype has no primitive — it is what an arm doing surgery on the XML produces, and the
  // packet has to name it rather than reporting a removal and an addition.
  const serialized = await serialize(document);
  const after = serialized.replace(
    new RegExp(`<((?:\\w+:)?)userTask id="${laned.id}"([\\s\\S]*?)</\\1userTask>`),
    (_, prefix, inner) => `<${prefix}serviceTask id="${laned.id}"${inner}</${prefix}serviceTask>`,
  );
  assert.notEqual(after, serialized, 'the retype had to actually land');

  const result = await diff(before, after);

  assert.deepEqual(result.added.map((entry) => entry.id), ['Msg_new']);
  assert.deepEqual(result.reowned, [{ id: laned.id, from: named.name.trim(), to: 'no lane' }]);
  assert.deepEqual(result.retyped, [{ id: laned.id, from: 'user', to: 'service' }]);

  const packet = await review(before, after, {});
  assert.match(packet, /retyped/);
  assert.match(packet, /reowned/);
  assert.match(packet, /no lane/);
});

test('a reflowed diagram is called out, not just counted', async () => {
  const before = await readFixture();
  // Every shape shifted by a different amount: the signature of a relayout, not of making room.
  let seed = 0;
  const after = before.replace(/x="(\d+)"/g, (_, value) => `x="${Number(value) + (seed += 7)}"`);

  const packet = await review(before, after, {});

  assert.match(packet, /distinct deltas — the diagram was reflowed/);
});

test('a lane with no name is reported by its id, not as an empty string', async () => {
  const before = await readFixture('miwg/C.1.0.bpmn');
  const document = await parse(before);
  const ir = project(document.definitions);
  const anonymous = ir.lanes.find((lane) => !lane.name?.trim());
  const inside = ir.nodes.find((node) => node.lane === anonymous.id);

  applyPatch(document, [{ op: 'set', id: inside.id, patch: { lane: null } }]);

  const result = await diff(before, await serialize(document));
  assert.deepEqual(result.reowned, [{ id: inside.id, from: anonymous.id, to: 'no lane' }]);
});

test('a packet for a removal and a lane move names both, and calls the risk destructive', async () => {
  const before = await readFixture('miwg/C.4.0.bpmn');
  const document = await parse(before);
  const node = '_aa275782-c989-49ba-bf94-c58916ca7bb5';
  const other = '_f8973a92-3d84-4672-a1a3-b0df154121e1';

  applyPatch(document, [
    { op: 'set', id: other, patch: { lane: '_937b5086-463f-4c8c-837d-f5eee5cbc1f4' } },
    { op: 'del', id: node },
  ]);

  const packet = await review(before, await serialize(document), {});

  assert.match(packet, /risk +destructive/);
  assert.match(packet, new RegExp(`removed[\\s\\S]*${node}`));
  assert.match(packet, new RegExp(`reowned[\\s\\S]*${other}`));
  assert.match(packet, /HR Department → Responsible Department/);
});
