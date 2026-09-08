import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPatch, block, blocks, byBpmn, byIr, project, tabulate } from '../../core/index.mjs';
import { normalizedFixture } from '../support/fixture.mjs';

test('every block declares a BPMN type, an IR word, and a positive shape', () => {
  assert.ok(blocks.length >= 20);
  for (const candidate of blocks) {
    assert.match(candidate.bpmn, /^bpmn:[A-Z]/, candidate.ir);
    assert.match(candidate.ir, /^[a-z][a-z_]*$/, candidate.bpmn);
    assert.ok(candidate.shape.w > 0 && candidate.shape.h > 0, candidate.ir);
    assert.ok(Object.isFrozen(candidate), candidate.ir);
  }
});

test('both directions of the table resolve to the same block', () => {
  for (const candidate of blocks) {
    assert.equal(byIr.get(candidate.ir), candidate, candidate.ir);
    for (const type of [candidate.bpmn, ...(candidate.also ?? [])]) {
      assert.equal(byBpmn.get(type), candidate, type);
    }
  }
  // A Transaction projects as a subprocess, but `add subprocess` mints a plain SubProcess.
  assert.equal(byBpmn.get('bpmn:Transaction').ir, 'subprocess');
  assert.equal(block('subprocess').bpmn, 'bpmn:SubProcess');
});

test('the table is the closed vocabulary: an unknown IR word is refused', () => {
  assert.throws(() => block('wormhole'), /Unknown node type "wormhole"/);
});

test('tabulate refuses a malformed or colliding block at import time', () => {
  const ok = { bpmn: 'bpmn:Task', ir: 'task', role: 'activity', glyph: null, shape: { w: 1, h: 1 } };
  const cases = [
    [{ ...ok, bpmn: 'Task' }, /Block "task" has no BPMN type/],
    [{ ...ok, ir: '' }, /Block "bpmn:Task" has no IR word/],
    [{ ...ok, shape: { w: 0, h: 1 } }, /Block "task" has no positive shape/],
    [{ ...ok, shape: undefined }, /Block "task" has no positive shape/],
    [{ ...ok, role: 'artifact' }, /Block "task" has no drawable role/],
    [{ ...ok, role: undefined }, /Block "task" has no drawable role/],
    // Not declaring a mark is the error; declaring `null` is a decision the notation respects.
    [{ ...ok, glyph: undefined }, /Block "task" declares no glyph/],
    [
      { ...ok, ir: 'xor', role: 'gateway', glyph: null },
      /Gateway "xor" has no mark to tell it from the others/,
    ],
  ];
  for (const [bad, expected] of cases) assert.throws(() => tabulate([bad]), expected);

  assert.throws(() => tabulate([ok, { ...ok, bpmn: 'bpmn:UserTask' }]), /Duplicate IR word "task"/);
  assert.throws(
    () => tabulate([ok, { ...ok, ir: 'user', also: ['bpmn:Task'] }]),
    /Duplicate BPMN type "bpmn:Task"/,
  );
});

// The guard: delete a block and its IR word stops being addable, so this fails.
test('every block round-trips add → project under its own IR word', async () => {
  for (const candidate of blocks) {
    const { document } = await normalizedFixture();
    const id = `N_${candidate.ir}`;
    applyPatch(document, [
      {
        op: 'add',
        type: candidate.ir,
        in: 'Payment',
        id,
        ...(candidate.ir === 'boundary' ? { on: 'Charge' } : {}),
      },
    ]);
    const node = project(document.definitions).nodes.find((found) => found.id === id);
    assert.equal(node?.type, candidate.ir, candidate.ir);
  }
});
