import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPatch, index, parse, project, serialize } from '../../core/index.mjs';
import { normalizedFixture } from '../support/fixture.mjs';

// The closed `set` allowlist, and the two operations that needed their own verbs.
// Every branch below was a defect before it was a rule: the open `element[key] = value`
// fallthrough these replace wrote any key straight onto the moddle object.

test('set refuses to write adjacency directly', async () => {
  const { document } = await normalizedFixture();
  for (const key of ['sourceRef', 'targetRef', 'incoming', 'outgoing', 'attachedToRef', 'flowNodeRef']) {
    assert.throws(
      () => applyPatch(document, [{ op: 'set', id: 'Flow_2', patch: { [key]: 'End_1' } }]),
      /cannot be set directly/,
      key,
    );
  }
});

test('set refuses to rewrite an id', async () => {
  const { document } = await normalizedFixture();
  assert.throws(
    () => applyPatch(document, [{ op: 'set', id: 'Charge', patch: { id: 'Renamed' } }]),
    /cannot be set directly/,
  );
});

test('set refuses a key that is not on the allowlist', async () => {
  const { document } = await normalizedFixture();
  assert.throws(
    () => applyPatch(document, [{ op: 'set', id: 'Charge', patch: { colour: 'red' } }]),
    /is not settable/,
  );
});

test('set writes documentation as a typed child, and clears it', async () => {
  const { document } = await normalizedFixture();
  applyPatch(document, [{ op: 'set', id: 'Charge', patch: { documentation: 'why we charge' } }]);
  const written = await serialize(document);
  assert.match(written, /why we charge/);

  applyPatch(document, [{ op: 'set', id: 'Charge', patch: { documentation: '' } }]);
  const cleared = await serialize(document);
  assert.doesNotMatch(cleared, /why we charge/);
});

test('set refuses a default flow that does not exist', async () => {
  const { document } = await normalizedFixture();
  assert.throws(
    () => applyPatch(document, [{ op: 'set', id: 'Charge', patch: { default: 'NoSuchFlow' } }]),
    /Default flow "NoSuchFlow" not found/,
  );
});

test('an unknown operation is refused by name', async () => {
  const { document } = await normalizedFixture();
  assert.throws(() => applyPatch(document, [{ op: 'teleport', id: 'Charge' }]), /Unknown operation/);
});

// --- move -------------------------------------------------------------------

const LANED = new URL('../../../bench/corpus/miwg/C.1.0.bpmn', import.meta.url);

async function lanedDocument() {
  const { readFile } = await import('node:fs/promises');
  const document = await parse(await readFile(LANED, 'utf8'));
  return { document, projection: project(document.definitions) };
}

test('move rewrites lane membership, and leaves the node in exactly one lane', async () => {
  const { document, projection } = await lanedDocument();
  const node = projection.nodes.find((n) => n.lane && /task|user|service/.test(n.type));
  const target = projection.lanes.find((lane) => lane.id !== node.lane);

  applyPatch(document, [{ op: 'move', id: node.id, lane: target.id }]);

  const after = project(document.definitions);
  assert.equal(after.nodes.find((n) => n.id === node.id).lane, target.id);

  const byId = index(document.definitions);
  const element = byId.get(node.id);
  let listed = 0;
  for (const lane of after.lanes) {
    if ((byId.get(lane.id).flowNodeRef || []).includes(element)) listed++;
  }
  assert.equal(listed, 1, 'a half-applied move leaves the node in both lanes or neither');
});

test('move refuses a missing node, a missing lane, and a target that is not a lane', async () => {
  const { document, projection } = await lanedDocument();
  const node = projection.nodes.find((n) => n.lane);
  const lane = projection.lanes[0];

  assert.throws(() => applyPatch(document, [{ op: 'move', id: 'Nope', lane: lane.id }]), /not found/);
  assert.throws(() => applyPatch(document, [{ op: 'move', id: node.id }]), /needs a "lane"/);
  assert.throws(() => applyPatch(document, [{ op: 'move', id: node.id, lane: 'Nope' }]), /Lane "Nope" not found/);
  assert.throws(
    () => applyPatch(document, [{ op: 'move', id: node.id, lane: node.id }]),
    /not a lane/,
  );
});

// --- message ----------------------------------------------------------------

const POOLED = new URL('../../../bench/corpus/miwg/C.2.0.bpmn', import.meta.url);

test('message creates a flow on the collaboration, not inside either process', async () => {
  const { readFile } = await import('node:fs/promises');
  const document = await parse(await readFile(POOLED, 'utf8'));
  const projection = project(document.definitions);

  const firstOfEachProcess = new Map();
  for (const node of projection.nodes) {
    if (/task|user|service|manual|send|receive/.test(node.type) && node.in && !firstOfEachProcess.has(node.in)) {
      firstOfEachProcess.set(node.in, node);
    }
  }
  const [source, target] = [...firstOfEachProcess.values()];

  const { created } = applyPatch(document, [
    { op: 'message', from: source.id, to: target.id, name: 'On its way', id: 'MF_Unit' },
  ]);
  assert.deepEqual(created, ['MF_Unit']);

  const byId = index(document.definitions);
  assert.equal(byId.get('MF_Unit').$parent.$type, 'bpmn:Collaboration');
  assert.ok(project(document.definitions).messageFlows.some((flow) => flow.id === 'MF_Unit'));
});

test('message mints an id when the requested one is taken', async () => {
  const { readFile } = await import('node:fs/promises');
  const document = await parse(await readFile(POOLED, 'utf8'));
  const projection = project(document.definitions);
  const byProcess = new Map();
  for (const node of projection.nodes) {
    if (/task|user|service|manual|send|receive/.test(node.type) && node.in && !byProcess.has(node.in)) {
      byProcess.set(node.in, node);
    }
  }
  const [source, target] = [...byProcess.values()];
  const { created } = applyPatch(document, [
    { op: 'message', from: source.id, to: target.id, id: source.id },
  ]);
  assert.notEqual(created[0], source.id);
});

test('message refuses missing endpoints and a file with no collaboration', async () => {
  const { readFile } = await import('node:fs/promises');
  const pooled = await parse(await readFile(POOLED, 'utf8'));
  const projection = project(pooled.definitions);
  const node = projection.nodes.find((n) => /task|user|service/.test(n.type));

  assert.throws(
    () => applyPatch(pooled, [{ op: 'message', from: 'Nope', to: node.id }]),
    /Source "Nope" not found/,
  );
  assert.throws(
    () => applyPatch(pooled, [{ op: 'message', from: node.id, to: 'Nope' }]),
    /Target "Nope" not found/,
  );

  // The handmade fixture is a single process with no pools to cross.
  const { document } = await normalizedFixture();
  assert.throws(
    () => applyPatch(document, [{ op: 'message', from: 'Charge', to: 'Review' }]),
    /no collaboration/,
  );
});

test('an insert into an empty container does not throw', async () => {
  // container.flowElements is undefined until something is in it, and reading .filter
  // off it threw. Reached on a real corpus file, never on a fixture built to be edited.
  const { document } = await normalizedFixture();
  const byId = index(document.definitions);
  const process = byId.get('Payment');
  const held = process.flowElements;
  process.flowElements = undefined;
  assert.doesNotThrow(() =>
    applyPatch(document, [{ op: 'add', type: 'user', name: 'Alone', in: 'Payment', id: 'Alone' }]),
  );
  process.flowElements = held;
});
