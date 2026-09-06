import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  diCoverage,
  insertAfter,
  references,
  project,
  propose,
  serialize,
  timeout,
} from '../../core/index.mjs';
import { normalizedFixture } from '../support/fixture.mjs';

// The guard for DEFERRED "Atomic multi-operation patches": a later invalid operation used to
// observe what earlier ones had already mutated. Remove the isolation and this test fails.
test('a plan whose second operation is invalid leaves the source document byte-identical', async () => {
  const { document } = await normalizedFixture();
  const before = await serialize(document);

  await assert.rejects(
    propose(document, [
      { op: 'set', id: 'Charge', patch: { name: 'Charged' } },
      { op: 'set', id: 'Nope', patch: { name: 'x' } },
    ]),
    (error) => {
      assert.equal(error.code, 'operation-failed');
      assert.match(error.message, /Operation 2 of 2 failed: Element "Nope" not found/);
      return true;
    },
  );

  assert.equal(await serialize(document), before);
});

test('a successful proposal never mutates the source document either', async () => {
  const { document } = await normalizedFixture();
  const before = await serialize(document);

  const result = await propose(document, [{ op: 'set', id: 'Charge', patch: { name: 'Charged' } }]);

  assert.equal(result.ok, true);
  assert.notEqual(result.xml, before);
  assert.match(result.xml, /name="Charged"/);
  assert.equal(await serialize(document), before);
});

test('a proposal reports every gate, and the diff it measured', async () => {
  const { document } = await normalizedFixture();
  const result = await propose(document, [{ op: 'set', id: 'Charge', patch: { name: 'Charged' } }]);

  assert.deepEqual(Object.keys(result.gates), [
    'parses',
    'xsdValid',
    'references',
    'semantics',
    'lintClean',
    'noCollateral',
    'diffSanity',
    'diCoverage',
  ]);
  for (const [name, gate] of Object.entries(result.gates)) assert.equal(gate.ok, true, name);

  assert.equal(result.diff.addedLines, 1);
  assert.equal(result.diff.removedLines, 1);
  assert.equal(result.diff.shapesMoved, 0);
  assert.deepEqual(result.changed, ['Charge']);
  assert.deepEqual(result.created, []);
});

test('a proposal places what it created and refuses to publish an incomplete diagram', async () => {
  const { document } = await normalizedFixture();
  const envelope = insertAfter(project(document.definitions), {
    anchor: 'Charge',
    step: { type: 'user', name: 'Verify identity' },
  });

  const result = await propose(document, envelope.plan);

  assert.equal(result.ok, true);
  assert.deepEqual(result.created, envelope.minted);
  assert.equal(result.gates.diCoverage.ok, true);
  for (const id of envelope.minted) assert.match(result.xml, new RegExp(`bpmnElement="${id}"`));
});

// One gate passing must never stand in for another: a dangling boundary is XSD-valid and lints
// clean, and only fails once something resolves references. Nothing does yet — PR-04 does.
test('a failing gate marks the proposal not ok and still reports the others', async () => {
  const { document } = await normalizedFixture();
  const result = await propose(document, [
    { op: 'connect', from: 'Charge', to: 'Charge', id: 'SelfLoop' },
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.gates.lintClean.ok, false);
  assert.equal(result.gates.parses.ok, true);
  assert.equal(result.gates.xsdValid.ok, true);
});

test('a proposal reports the DI it could not place, for old gaps and new elements alike', async () => {
  const { document } = await normalizedFixture('miwg/B.1.0.bpmn');
  const host = '_219b9ca1-d4c5-497d-a4f7-06a44a6da20e';
  const envelope = timeout(project(document.definitions), {
    on: host,
    after: 'P3D',
    to: '_94efa7e0-2322-4fc3-a5bf-6c6296488927',
  });

  const before = diCoverage(document.definitions);
  assert.equal(before.ok, false, 'B.1.0 already has DI gaps');

  const result = await propose(document, envelope.plan);

  assert.equal(result.ok, false);
  assert.equal(result.gates.diCoverage.ok, false);
  assert.equal(result.gates.diCoverage.need, before.need + 2);
  // The boundary lands on a host that has DI, so what we created is covered; the failure is the
  // file's own pre-existing gap, reported rather than hidden behind a passing XSD gate.
  const missing = new Set(result.gates.diCoverage.missing.map((entry) => entry.id));
  for (const id of envelope.minted) assert.equal(missing.has(id), false, id);
});

// C.7.0 ships a BPMNEdge with no bpmnElement: XSD-legal, and an orphan the reference gate reports.
// An edit to that file must not be blamed for it — but must still be blamed for a new one.
test('a proposal fails on the references it broke, not on the ones it inherited', async () => {
  const { document } = await normalizedFixture('miwg/C.7.0.bpmn');
  const inherited = await references(await serialize(document));
  assert.equal(inherited.ok, false, 'C.7.0 carries a pre-existing orphan edge');

  const activity = '_392c86ba-38b5-4dc9-b98d-f97ad4c2add5';
  const process = '_4a690dd7-809a-4fa9-ad63-515ac6685375';

  const clean = await propose(document, [{ op: 'set', id: activity, patch: { name: 'Renamed' } }]);
  assert.equal(clean.gates.references.ok, true);
  assert.deepEqual(clean.gates.references.introduced, []);
  assert.deepEqual(clean.gates.references.findings, inherited.findings);

  const broken = await propose(document, [
    { op: 'add', type: 'boundary', in: process, id: 'Dangling' },
  ]);
  assert.equal(broken.gates.references.ok, false);
  assert.deepEqual(broken.gates.references.introduced, [
    { rule: 'unresolved-reference', id: 'Dangling', attr: 'attachedToRef' },
  ]);
  assert.ok(
    broken.gates.references.findings.length > broken.gates.references.introduced.length,
    'the inherited finding is still reported, just not blamed on this edit',
  );
  assert.equal(broken.ok, false);
});
