import assert from 'node:assert/strict';
import { test } from 'node:test';

import { containerOf, index, parse, serialize, walk } from '../../core/index.mjs';
import { readFixture } from '../support/fixture.mjs';

test('parse and serialize preserve a valid moddle document', async () => {
  const xml = await readFixture();
  const document = await parse(xml);

  assert.equal(document.definitions.$type, 'bpmn:Definitions');
  assert.equal(index(document.definitions).get('Charge').$type, 'bpmn:ServiceTask');

  const normalized = await serialize(document);
  const reparsed = await parse(normalized);
  assert.equal(index(reparsed.definitions).get('Charge').name, 'Charge card');
});

test('parse rejects malformed XML', async () => {
  await assert.rejects(parse('<not-bpmn>'), /unparsable content|unexpected end/i);
});

test('document traversal ignores non-objects and resolves root containers', async () => {
  assert.deepEqual([...walk(null)], []);
  assert.deepEqual([...walk('not-an-object')], []);
  const hidden = { id: 'Hidden' };
  const visible = { id: 'Visible', $parent: hidden, $model: hidden, $descriptor: hidden };
  assert.deepEqual([...walk(visible)], [visible]);

  const document = await parse(await readFixture());
  assert.equal(containerOf(document.definitions), null);
  assert.equal(containerOf(index(document.definitions).get('Charge')), 'Payment');
});
