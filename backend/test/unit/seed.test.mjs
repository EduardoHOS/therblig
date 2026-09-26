import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  diCoverage,
  lintClean,
  parse,
  parses,
  project,
  references,
  seed,
  semantics,
  serialize,
  xsdValid,
} from '../../core/index.mjs';

const CORRECTNESS = { config: { extends: 'bpmnlint:correctness' } };

async function reread(document) {
  const xml = await serialize(document);
  const { definitions } = await parse(xml);
  return { xml, definitions, ir: project(definitions) };
}

test('a seed is a start and an end, connected, with DI for all three', async () => {
  const { document, ids } = seed({ name: 'Pedido', start: 'Pedido recebido', end: 'Pedido concluído' });
  const { definitions, ir } = await reread(document);

  assert.deepEqual(
    ir.nodes.map((node) => [node.id, node.type, node.name]),
    [[ids.start, 'start', 'Pedido recebido'], [ids.end, 'end', 'Pedido concluído']],
  );
  assert.deepEqual(ir.flows.map((flow) => [flow.id, flow.from, flow.to]), [[ids.flow, ids.start, ids.end]]);
  assert.equal(ir.processes[0].id, ids.process);
  assert.equal(ir.processes[0].name, 'Pedido');
  assert.equal(ir.processes[0].executable, false);
  assert.equal(definitions.id, ids.definitions);

  const coverage = diCoverage(definitions);
  assert.equal(coverage.ok, true);
  assert.equal(coverage.covered, 3);
  assert.deepEqual(coverage.missing, []);
});

test('a seed passes every gate', async () => {
  const { xml } = await reread(seed({ name: 'Onboarding' }).document);
  assert.equal((await parses(xml)).ok, true);
  assert.equal((await xsdValid(xml)).ok, true);
  assert.equal((await references(xml)).ok, true);
  assert.equal((await semantics(xml)).ok, true);
  assert.equal((await lintClean(xml, CORRECTNESS)).ok, true);
});

test('a seed is deterministic and its defaults are Start and End', async () => {
  const first = await reread(seed({ name: 'Same' }).document);
  const second = await reread(seed({ name: 'Same' }).document);
  assert.equal(first.xml, second.xml);
  assert.deepEqual(first.ir.nodes.map((node) => node.name), ['Start', 'End']);
});

test('spaces, accents and a leading digit still yield XSD-valid ids', async () => {
  const { document, ids } = seed({ name: 'Aprovação de crédito', start: '1º contato', end: 'Fim' });
  for (const id of Object.values(ids)) assert.match(id, /^[A-Za-z_][A-Za-z0-9_]*$/, id);
  assert.equal((await xsdValid((await reread(document)).xml)).ok, true);
});

test('executable lands on the process', async () => {
  const { ir } = await reread(seed({ name: 'Run', executable: true }).document);
  assert.equal(ir.processes[0].executable, true);
});

test('a blank or missing name is refused with a code', () => {
  for (const args of [{ name: '   ' }, { name: 7 }, {}, undefined]) {
    assert.throws(() => seed(args), (error) => {
      assert.equal(error.code, 'invalid-name');
      assert.match(error.message, /needs a name/);
      return true;
    });
  }
});
