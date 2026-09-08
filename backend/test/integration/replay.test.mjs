import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { applyPatch, parse, placeNew, project, serialize } from '../../core/index.mjs';
import { byId } from '../../../bench/tasks/tasks.mjs';

const run = promisify(execFile);
const REPLAY = fileURLToPath(new URL('../../../bench/harness/replay.mjs', import.meta.url));
const CORPUS = fileURLToPath(new URL('../../../bench/corpus/', import.meta.url));

async function fixture(task) {
  return parse(await readFile(join(CORPUS, task.file), 'utf8'));
}

async function record(root, cell) {
  const directory = join(root, '2026-01-01T00-00-00', cell.task, cell.arm);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${cell.run}.json`), JSON.stringify(cell));
}

const replay = async (root) => (await run(process.execPath, [REPLAY, root])).stdout;

test('replay scores nothing when nothing has been recorded, and says so', async () => {
  const root = await mkdtemp(join(tmpdir(), 'treadle-runs-'));
  assert.match(await replay(root), /no recorded runs/);
});

// The assertion has to reject a file that was not edited, or the whole bake-off measures nothing.
test('replay fails a cell that produced the file unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'treadle-runs-'));
  const task = byId.get('T04');
  await record(root, {
    task: task.id,
    arm: 'raw',
    run: 1,
    xml: await readFile(join(CORPUS, task.file), 'utf8'),
    cost_usd: 0.5,
  });

  const output = await replay(root);
  assert.match(output, /T04\s+0\/1/);
  assert.match(output, /the step is still there/);
});

test('replay passes a cell that made the edit the task asked for', async () => {
  const root = await mkdtemp(join(tmpdir(), 'treadle-runs-'));
  const task = byId.get('T04');
  const document = await fixture(task);
  const ir = project(document.definitions);
  const target = ir.nodes.find((node) => /send rejection/i.test(node.name ?? ''));
  const entry = ir.flows.find((flow) => flow.to === target.id);
  const exit = ir.flows.find((flow) => flow.from === target.id);

  applyPatch(document, [
    { op: 'set', id: entry.id, patch: { to: exit.to } },
    { op: 'del', id: target.id },
  ]);

  await record(root, { task: task.id, arm: 'treadle', run: 1, xml: await serialize(document), cost_usd: 0.25 });

  const output = await replay(root);
  assert.match(output, /T04\s+1\/1/);
  assert.match(output, /\$0\.25/);
  assert.doesNotMatch(output, /why each failing cell/);
});

// A gate failure and a wrong edit are different findings, and the report has to tell them apart.
test('replay separates a broken document from a wrong one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'treadle-runs-'));
  const task = byId.get('T01');
  const document = await fixture(task);
  const ir = project(document.definitions);
  const automatic = ir.nodes.find((node) => /automatically/i.test(node.name ?? ''));

  // Right shape, wrong place: the review lands after the automatic check instead of before it.
  const { created } = applyPatch(document, [
    { op: 'add', type: 'user', name: 'Review score', id: 'Misplaced', in: automatic.in, after: automatic.id },
  ]);
  placeNew(document, created);
  await record(root, { task: task.id, arm: 'raw', run: 1, xml: await serialize(document), cost_usd: 0.1 });

  await record(root, {
    task: task.id,
    arm: 'raw_ir',
    run: 1,
    xml: '<bpmn:definitions',
    cost_usd: 0.1,
  });

  const output = await replay(root);
  assert.match(output, /T01\s+0\/1\s+0\/1/);
  assert.match(output, /does not parse/);
});

test('replay reports a cell that crashed without producing anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'treadle-runs-'));
  await record(root, { task: 'T13', arm: 'raw', run: 1, xml: null, crash: 'stream closed', cost_usd: 0 });

  const output = await replay(root);
  assert.match(output, /T13\s+0\/1/);
  assert.match(output, /crashed: stream closed/);
});

test('every task refuses the file it starts from', async () => {
  for (const task of byId.values()) {
    const ir = project((await fixture(task)).definitions);
    assert.ok(task.check(ir, ir).length > 0, `${task.id} passes without any edit`);
  }
});
