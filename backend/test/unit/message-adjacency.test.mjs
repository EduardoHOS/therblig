import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPatch, index, project, serialize } from '../../core/index.mjs';
import { normalizedFixture } from '../support/fixture.mjs';

async function pooled() {
  const { document } = await normalizedFixture('miwg/C.2.0.bpmn');
  const nodes = project(document.definitions).nodes.filter((node) => /task|user|service|manual|send|receive/.test(node.type));
  const source = nodes[0];
  const targets = nodes.filter((node) => node.in !== source.in);
  assert.ok(targets.length >= 2, 'fixture needs two nodes in another pool');
  return { document, source: source.id, target: targets[0].id, next: targets[1].id };
}

for (const op of ['connect', 'message']) {
  test(`${op} keeps cross-pool message flows out of sequence adjacency when created and retargeted`, async () => {
    const { document, source, target, next } = await pooled();
    const byId = index(document.definitions);
    const adjacency = [source, target, next].map((id) => ({
      incoming: [...(byId.get(id).incoming ?? [])], outgoing: [...(byId.get(id).outgoing ?? [])],
    }));
    applyPatch(document, [{ op, from: source, to: target, id: 'CrossPool' }]);
    applyPatch(document, [{ op: 'set', id: 'CrossPool', patch: { to: next } }]);
    const flow = index(document.definitions).get('CrossPool');
    assert.equal(flow.$type, 'bpmn:MessageFlow');
    assert.equal(flow.sourceRef.id, source);
    assert.equal(flow.targetRef.id, next);
    [source, target, next].forEach((id, at) => {
      assert.deepEqual(byId.get(id).incoming ?? [], adjacency[at].incoming);
      assert.deepEqual(byId.get(id).outgoing ?? [], adjacency[at].outgoing);
    });
    const xml = await serialize(document);
    assert.doesNotMatch(xml, /<(?:\w+:)?(?:incoming|outgoing)>CrossPool<\//);
  });

  test(`${op} removes message flows when an endpoint is deleted`, async () => {
    const { document, source, target } = await pooled();
    applyPatch(document, [{ op, from: source, to: target, id: 'CrossPool' }]);
    const result = applyPatch(document, [{ op: 'del', id: source }]);
    assert.ok(result.changed.includes('CrossPool'));
    assert.equal(index(document.definitions).has('CrossPool'), false);
    assert.doesNotMatch(await serialize(document), /id="CrossPool"/);
  });
}

test('the file API can keep an explicit connect as a sequence flow for oracle validation', async () => {
  const { document, source, target } = await pooled();
  applyPatch(document, [{ op: 'connect', from: source, to: target, id: 'ExplicitSequence' }], {
    inferMessageFlows: false,
  });
  const byId = index(document.definitions);
  const flow = byId.get('ExplicitSequence');
  assert.equal(flow.$type, 'bpmn:SequenceFlow');
  assert.equal(flow.$parent, byId.get(source).$parent);
  assert.ok(byId.get(source).outgoing.includes(flow));
  assert.ok(byId.get(target).incoming.includes(flow));
});
