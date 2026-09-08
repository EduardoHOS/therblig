import assert from 'node:assert/strict';
import { test } from 'node:test';

import { conform, parse, project } from '../../core/index.mjs';
import { readFixture } from '../support/fixture.mjs';

const claim = async () => (await parse(await readFixture('handmade/parallel-join.bpmn'))).definitions;

test('a trace the model allows conforms, and says what it never reached', async () => {
  const definitions = await claim();

  const result = conform(definitions, ['Received', 'Split', 'Cover', 'Join', 'Decide', 'Pay', 'Settled']);

  assert.equal(result.ok, true);
  assert.equal(result.diverged, null);
  // The question worth asking of a real process: nobody took the fraud check or the rejection.
  assert.deepEqual(result.unvisited.sort(), ['Fraud', 'Reject']);
});

test('a step the model has no path to is named, with what came before it', async () => {
  const definitions = await claim();

  const result = conform(definitions, ['Received', 'Split', 'Pay']);

  assert.equal(result.ok, false);
  assert.deepEqual(result.diverged, {
    at: 2,
    id: 'Pay',
    after: 'Split',
    reason: 'no path leads here from the step before',
  });
});

test('a trace that starts in the middle is a divergence at its first step', async () => {
  const result = conform(await claim(), ['Pay', 'Settled']);

  assert.deepEqual(result.diverged, {
    at: 0,
    id: 'Pay',
    after: null,
    reason: 'the model does not start here',
  });
});

test('an id the model has never heard of is reported as such', async () => {
  const result = conform(await claim(), ['Received', 'CallTheCustomer']);

  assert.equal(result.diverged.reason, 'not an element of this model');
  assert.deepEqual(result.unknown, ['CallTheCustomer']);
});

test('a boundary event follows its host, which is how it actually runs', async () => {
  const document = await parse(await readFixture('miwg/C.9.0.bpmn'));
  const ir = project(document.definitions);
  const boundary = ir.nodes.find((node) => node.type === 'boundary');
  assert.ok(boundary?.on, 'C.9.0 has an error boundary');

  // No sequence flow leads into a boundary event; it fires because its host ran.
  const result = conform(document.definitions, [boundary.on, boundary.id]);

  assert.equal(result.diverged?.at, 0, 'the host is not a start event, so only that diverges');
  assert.equal(conform(document.definitions, ['StartEvent_ApplicationReceived']).ok, true);
});

test('an unknown id at the very first step has nothing before it to name', async () => {
  const result = conform(await claim(), ['NotAnElement', 'Received']);

  assert.deepEqual(result.diverged, {
    at: 0,
    id: 'NotAnElement',
    after: null,
    reason: 'not an element of this model',
  });
});

test('a model with nothing in it accepts no trace and lists nothing unvisited', async () => {
  const empty = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P" isExecutable="true" />
</bpmn:definitions>`;
  const definitions = (await parse(empty)).definitions;

  assert.deepEqual(conform(definitions, []).unvisited, []);
  assert.equal(conform(definitions, ['anything']).diverged.reason, 'not an element of this model');
});
