import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPatch, diCoverage, index, parse, placeNew, project, serialize, walk } from '../../core/index.mjs';
import { inspectTree } from '../../oracle/inspect.mjs';
import { normalizedFixture } from '../support/fixture.mjs';

const PROCESS = 'VacationRequestProcess';
const SOURCE = '_5e16a4e0-0f23-482a-be47-d3edbc5741ba';
const TARGET = '_1cd5fe29-b3ec-4f21-a1aa-57773f0729ca';

for (const [kind, operation] of [
  ['insert', { op: 'add', type: 'user', id: 'CollisionInsert', in: PROCESS, between: [SOURCE, TARGET] }],
  ['boundary', { op: 'add', type: 'boundary', id: 'CollisionBoundary', in: PROCESS, on: SOURCE, event: 'timer' }],
  ['split', { op: 'add', type: 'xor', id: 'CollisionSplit', in: PROCESS, between: [SOURCE, TARGET] }],
]) {
  test(`${kind} survives serialization when a vendor reference repeats its container id`, async () => {
    const { document } = await normalizedFixture('miwg/C.8.0.bpmn');
    const baseline = new Set(inspectTree(document.definitions).map((finding) => `${finding.code}:${finding.elements.join('|')}`));
    const references = [...walk(document.definitions)].filter((element) => element.$descriptor?.isGeneric && element.id === PROCESS);
    assert.ok(references.length > 0, 'fixture must contain the vendor id collision');
    const extensionsBefore = references.map((element) => JSON.stringify(element));
    const { created } = applyPatch(document, [operation]);
    const process = index(document.definitions).get(PROCESS);
    assert.equal(process.$type, 'bpmn:Process');
    for (const id of created) assert.equal(index(document.definitions).get(id).$parent, process);
    placeNew(document, created);

    const reparsed = await parse(await serialize(document));
    const after = index(reparsed.definitions);
    for (const id of created) assert.ok(after.has(id), `${id} disappeared during serialization`);
    assert.equal(diCoverage(reparsed.definitions).ok, true);
    const errors = inspectTree(reparsed.definitions).filter((finding) => finding.severity === 'error' && !baseline.has(`${finding.code}:${finding.elements.join('|')}`));
    assert.deepEqual(errors, []);
    assert.deepEqual(references.map((element) => JSON.stringify(element)), extensionsBefore);
    const ir = project(reparsed.definitions);
    assert.ok(ir.nodes.some((node) => node.id === operation.id));
  });
}
