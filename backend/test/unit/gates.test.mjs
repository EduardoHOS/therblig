import assert from 'node:assert/strict';
import { test } from 'node:test';
import Linter from 'bpmnlint/lib/linter.js';

import { index, parse, serialize } from '../../core/document.mjs';

import { fingerprint, lintClean, parses, scoreAll, xsdValid } from '../../core/gates.mjs';
import { readFixture } from '../support/fixture.mjs';

// A gate that cannot run must report a failure, never throw: propose() treats every gate the same
// way, so an exception escaping one of them would abort the whole proposal instead of failing it.
test('a gate that cannot run reports not ok instead of throwing', async () => {
  const malformed = '<bpmn:definitions><unclosed>';

  const parsed = await parses(malformed);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /Error: /);

  const linted = await lintClean(malformed);
  assert.equal(linted.ok, false);
  assert.deepEqual(
    linted.errors.map((entry) => entry.rule),
    ['linter'],
  );

  const validated = await xsdValid(undefined);
  assert.equal(validated.ok, false);
  assert.match(validated.errors[0], /^validator error: /);
});

test('scoreAll stops at the first gate when the result does not parse', async () => {
  const before = await readFixture();
  const result = await scoreAll(before, '<not-bpmn/>');

  assert.deepEqual(Object.keys(result.gates), ['parses']);
  assert.equal(result.passed, 0);
  assert.equal(result.of, 7);
});

test('the XSD gate resolves its schemas against the module, not the working directory', async () => {
  const original = process.cwd();
  process.chdir('/');
  try {
    assert.equal((await xsdValid(await readFixture())).ok, true);
  } finally {
    process.chdir(original);
  }
});

// Measured against xmllint-wasm 5.3.0: `errors` is always an array and every entry carries a
// `message`. This test is what keeps that claim honest if the validator is ever bumped.
test('the XSD gate reports the validator messages for an invalid document', async () => {
  const invalid =
    '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"/>';
  const result = await xsdValid(invalid);

  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  for (const message of result.errors) assert.equal(typeof message, 'string');
  assert.match(result.errors[0], /targetNamespace/);
});

// Rules that need DI are unfair to semantic-only output, which is what an arm editing the tree
// without a layouter produces. No corpus file is DI-free, so the case has to be constructed.
test('the lint gate skips DI-dependent rules when the document has no DI', async () => {
  const semanticOnly = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>F</bpmn:outgoing></bpmn:startEvent>
    <bpmn:endEvent id="E"><bpmn:incoming>F</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="F" sourceRef="S" targetRef="E" />
  </bpmn:process>
</bpmn:definitions>`;

  const rules = async (hasDI) =>
    new Set((await lintClean(semanticOnly, { hasDI })).errors.map((entry) => entry.rule));

  assert.ok((await rules(true)).has('no-bpmndi'));
  assert.equal((await rules(false)).has('no-bpmndi'), false);
});

test('a reference that does not resolve is dropped by the parser, not kept as a name', async () => {
  const dangling = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P">
    <bpmn:sequenceFlow id="F" sourceRef="S" targetRef="Missing" />
  </bpmn:process>
</bpmn:definitions>`;

  const flow = (await fingerprint(dangling)).get('F');
  assert.equal(flow.tgt, undefined);
  assert.equal(flow.src, undefined);
  assert.equal(flow.name, null);
});


test('fixing one label cannot hide a new label error on another element', async () => {
  const document = await parse(await readFixture());
  const nodes = index(document.definitions);
  const reviewName = nodes.get('Review').name;
  nodes.get('Review').name = undefined;
  const before = await serialize(document);
  nodes.get('Review').name = reviewName;
  nodes.get('Charge').name = undefined;
  const after = await serialize(document);

  const { gates } = await scoreAll(before, after, { expectChangedIds: ['Review', 'Charge'] });
  assert.equal(gates.lintClean.correctness.ok, true);
  assert.equal(gates.lintClean.ok, false);
  assert.equal(gates.lintClean.styleDelta, 1);
  assert.deepEqual(gates.lintClean.introduced, ['label-required:Charge']);
});

for (const scenario of [
  { name: 'counts each additional repeated violation', before: ['Charge', 'Charge', 'Review'], after: ['Charge', 'Charge', 'Charge'], introduced: ['label-required:Charge'] },
  { name: 'allows fewer repeated violations', before: ['Charge', 'Charge'], after: ['Charge'], introduced: [] },
  { name: 'allows unchanged repeated violations', before: ['Charge', 'Charge'], after: ['Charge', 'Charge'], introduced: [] },
  { name: 'counts findings without an element id', before: [undefined], after: [undefined, undefined], introduced: ['label-required:'] },
]) {
  test(`style differential ${scenario.name}`, async (context) => {
    const document = await parse(await readFixture());
    document.definitions.name = 'Before';
    const before = await serialize(document);
    document.definitions.name = 'After';
    const after = await serialize(document);

    // Real linter reports may repeat a rule/element pair. Inject only those reports;
    // scoreAll still parses, validates and calculates the differential itself.
    context.mock.method(Linter.prototype, 'lint', async (tree, config) => {
      if (config.extends === 'bpmnlint:correctness') return {};
      const ids = tree.name === 'Before' ? scenario.before : scenario.after;
      return { 'label-required': ids.map((id) => ({ id, category: 'error', message: 'Missing label' })) };
    });
    const { gates } = await scoreAll(before, after);
    assert.equal(gates.lintClean.ok, scenario.introduced.length === 0);
    assert.equal(gates.lintClean.styleDelta, scenario.introduced.length);
    assert.equal(gates.lintClean.styleErrors, scenario.after.length);
    assert.deepEqual(gates.lintClean.introduced, scenario.introduced);
  });
}
