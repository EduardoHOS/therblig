import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../../cli/main.mjs', import.meta.url));
const CORPUS = fileURLToPath(new URL('../../../bench/corpus/', import.meta.url));

async function workspace(fixture = 'handmade/zeebe-roundtrip.bpmn') {
  const cwd = await mkdtemp(join(tmpdir(), 'treadle-write-'));
  await cp(join(CORPUS, fixture), join(cwd, 'p.bpmn'));
  return cwd;
}

async function treadle(args, cwd) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

const read = (cwd) => readFile(join(cwd, 'p.bpmn'), 'utf8');
const temps = async (cwd) => (await readdir(cwd)).filter((name) => name.endsWith('.tmp'));

test('fmt reports the one-time reformat and changes nothing without --write', async () => {
  const cwd = await workspace();
  const before = await read(cwd);

  const { code, stdout } = await treadle(['fmt', 'p.bpmn'], cwd);

  assert.equal(code, 0);
  assert.match(stdout, /would reformat: −\d+ \+\d+ lines/);
  assert.match(stdout, /--write/);
  assert.equal(await read(cwd), before);
});

test('fmt --write reports the reformat it actually made, then is idempotent', async () => {
  const cwd = await workspace('miwg/C.9.0.bpmn');

  const first = await treadle(['fmt', 'p.bpmn', '--write'], cwd);
  assert.equal(first.code, 0);
  const [, removed, added] = first.stdout.match(/reformatted: −(\d+) \+(\d+) lines/) ?? [];
  assert.ok(Number(removed) > 0 && Number(added) > 0, first.stdout);
  const once = await read(cwd);

  const { stdout } = await treadle(['fmt', 'p.bpmn', '--write'], cwd);
  assert.equal(await read(cwd), once);
  assert.match(stdout, /already normalised/);
  assert.deepEqual(await temps(cwd), []);
});

// F3 reproduced through the real entrypoint, not through a helper that cannot fail the same way.
test('apply --write makes a one-line diff and moves nothing', async () => {
  const cwd = await workspace();
  await treadle(['fmt', 'p.bpmn', '--write'], cwd);
  const normalised = await read(cwd);

  const { code, stdout } = await treadle(
    ['apply', 'p.bpmn', '--op', 'rename', '--args', '{"id":"Charge","name":"Charge the card"}', '--write'],
    cwd,
  );

  assert.equal(code, 0);
  assert.match(stdout, /risk *safe/);
  assert.match(stdout, /Renamed "Charge card" to "Charge the card"/);
  assert.match(stdout, /−1 \+1 lines/);
  assert.match(stdout, /0 of \d+ shapes/);

  const after = await read(cwd);
  assert.match(after, /name="Charge the card"/);
  assert.equal(after.split('\n').length, normalised.split('\n').length);
  assert.deepEqual(await temps(cwd), []);
});

test('apply prints the envelope and writes nothing without --write', async () => {
  const cwd = await workspace();
  const before = await read(cwd);

  const { code, stdout } = await treadle(
    [
      'apply', 'p.bpmn',
      '--op', 'timeout',
      '--args', '{"on":"Charge","after":"P3D","to":"Review","name":"Too slow"}',
    ],
    cwd,
  );

  assert.equal(code, 0);
  assert.match(stdout, /If "Charge card" exceeds P3D, continue to "Review exception"/);
  assert.match(stdout, /ok +references/);
  assert.match(stdout, /ok +lintClean/);
  assert.match(stdout, /inverse/);
  assert.equal(await read(cwd), before);
});

// The first end-to-end run found this: an unlabelled handler is an unlabelled handler, and
// bpmnlint says so. The op takes a name rather than inventing one.
test('a handler without a name is reported, not hidden', async () => {
  const cwd = await workspace();

  const { code, stdout } = await treadle(
    ['apply', 'p.bpmn', '--op', 'timeout', '--args', '{"on":"Charge","after":"P3D","to":"Review"}'],
    cwd,
  );

  assert.equal(code, 1);
  assert.match(stdout, /fail +lintClean/);
});

test('a risk above the allowance exits 3 and names the level and the flag', async () => {
  const cwd = await workspace();
  const before = await read(cwd);

  const { code, stderr } = await treadle(
    ['apply', 'p.bpmn', '--op', 'bypass', '--args', '{"id":"Review"}', '--write'],
    cwd,
  );

  assert.equal(code, 3);
  assert.match(stderr, /destructive/);
  assert.match(stderr, /--allow/);
  assert.equal(await read(cwd), before);
  assert.deepEqual(await temps(cwd), []);
});

test('the same edit goes through once the allowance names its level', async () => {
  const cwd = await workspace();
  const { code } = await treadle(
    ['apply', 'p.bpmn', '--op', 'bypass', '--args', '{"id":"Review"}', '--write', '--allow', 'destructive'],
    cwd,
  );

  assert.equal(code, 0);
  assert.doesNotMatch(await read(cwd), /id="Review"/);
});

test('a failing gate leaves the file untouched even with --write', async () => {
  const cwd = await workspace('miwg/C.4.0.bpmn');
  await treadle(['fmt', 'p.bpmn', '--write'], cwd);
  const before = await read(cwd);

  // Conditioning one exit of a two-way gateway introduces a style error the gate reports.
  const { code, stdout } = await treadle(
    [
      'apply', 'p.bpmn',
      '--op', 'guard',
      '--args', '{"flow":"_7e9d8b8b-faa9-4264-858b-7454702c4ec2","if":"=rejected"}',
      '--write', '--allow', 'routing',
    ],
    cwd,
  );

  assert.equal(code, 1);
  assert.match(stdout, /fail +lintClean/);
  assert.equal(await read(cwd), before);
  assert.deepEqual(await temps(cwd), []);
});

test('a plan of raw primitives applies, and its risk is computed the same way', async () => {
  const cwd = await workspace();
  await writeFile(
    join(cwd, 'plan.json'),
    JSON.stringify([{ op: 'set', id: 'Charge', patch: { name: 'Cobrar' } }]),
  );

  const { code, stdout } = await treadle(['apply', 'p.bpmn', '--plan', 'plan.json', '--write'], cwd);

  assert.equal(code, 0);
  assert.match(stdout, /risk *safe/);
  assert.match(await read(cwd), /name="Cobrar"/);
});

test('apply refuses an unknown op and an unusable argument without touching the file', async () => {
  const cwd = await workspace();
  const before = await read(cwd);

  for (const args of [
    ['--op', 'teleport', '--args', '{}'],
    ['--op', 'rename', '--args', 'not json'],
    ['--op', 'rename'],
    ['--plan', 'missing.json'],
    [],
  ]) {
    const { code, stderr } = await treadle(['apply', 'p.bpmn', ...args, '--write'], cwd);
    assert.equal(code, 2, args.join(' '));
    assert.ok(stderr.length > 0, args.join(' '));
  }

  assert.equal(await read(cwd), before);
});

test('a precondition refusal reaches the user as its remedy, not as a stack', async () => {
  const cwd = await workspace();

  const { code, stderr } = await treadle(
    ['apply', 'p.bpmn', '--op', 'insertAfter', '--args', '{"anchor":"End_1","step":{"type":"user"}}'],
    cwd,
  );

  assert.equal(code, 2);
  assert.match(stderr, /anchor-no-outgoing/);
  assert.match(stderr, /use connect/);
  assert.doesNotMatch(stderr, /at .*\.mjs:\d+/);
});

test('review reads two files and says what changed between them', async () => {
  const cwd = await workspace();
  await treadle(['fmt', 'p.bpmn', '--write'], cwd);
  await cp(join(cwd, 'p.bpmn'), join(cwd, 'to-be.bpmn'));
  await treadle(
    ['apply', 'to-be.bpmn', '--op', 'rename', '--args', '{"id":"Charge","name":"Cobrar"}', '--write'],
    cwd,
  );

  const { code, stdout } = await treadle(['review', 'p.bpmn', 'to-be.bpmn'], cwd);

  assert.equal(code, 0);
  assert.match(stdout, /^# Review$/m);
  assert.match(stdout, /renamed/);
  assert.match(stdout, /"Charge card" → "Cobrar"/);
  assert.match(stdout, /Every gate passed/);
});

test('review needs both sides and says so', async () => {
  const cwd = await workspace();
  const { code, stderr } = await treadle(['review', 'p.bpmn'], cwd);

  assert.equal(code, 2);
  assert.match(stderr, /two files/);
});
