import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = new URL('../../cli/main.mjs', import.meta.url).pathname;
const CORPUS = new URL('../../../bench/corpus/', import.meta.url).pathname;

// Spawn the real entrypoint, from a directory the user might actually be in.
async function treadle(args, { cwd = CORPUS } = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('project prints the IR as JSON and nothing else on stdout', async () => {
  const { code, stdout } = await treadle(['project', 'handmade/zeebe-roundtrip.bpmn']);

  assert.equal(code, 0);
  const ir = JSON.parse(stdout);
  assert.deepEqual(
    ir.nodes.map((node) => node.id),
    ['Start_1', 'Charge', 'Review', 'End_1'],
  );
});

test('project --scope narrows to one container', async () => {
  const { stdout } = await treadle(['project', 'miwg/C.4.0.bpmn', '--scope', '_42cba3a9-a8ab-40b5-b9a4-2e8f32be364e']);
  const ir = JSON.parse(stdout);

  assert.ok(ir.nodes.length > 0);
  for (const node of ir.nodes) {
    assert.ok(node.in === '_42cba3a9-a8ab-40b5-b9a4-2e8f32be364e' || node.on, node.id);
  }
});

test('lint passes a clean file and reports every gate it ran', async () => {
  const { code, stdout } = await treadle(['lint', 'handmade/zeebe-roundtrip.bpmn']);

  assert.equal(code, 0);
  for (const gate of ['parses', 'xsdValid', 'references', 'lintClean']) {
    assert.match(stdout, new RegExp(`ok +${gate}`), gate);
  }
});

test('lint exits 1 and names the finding on a file that fails a gate', async () => {
  const { code, stdout } = await treadle(['lint', 'miwg/C.7.0.bpmn']);

  assert.equal(code, 1);
  assert.match(stdout, /fail +references/);
  assert.match(stdout, /unresolved-reference/);
  assert.match(stdout, /_985753e3-a4ce-486b-908a-509d382259ed/);
});

test('explain summarises the process without calling a model', async () => {
  const { code, stdout } = await treadle(['explain', 'handmade/zeebe-roundtrip.bpmn']);

  assert.equal(code, 0);
  assert.match(stdout, /^handmade\/zeebe-roundtrip\.bpmn — 1 process$/m);
  assert.match(stdout, /Payment.*executable/);
  assert.match(stdout, /4 nodes/);
  assert.match(stdout, /Order placed → Charge card → Review exception → Done/);
});

test('explain reports handlers, and reachability that accounts for how a node really runs', async () => {
  const { stdout } = await treadle(['explain', 'miwg/C.9.0.bpmn']);

  assert.match(stdout, /handlers:\n {4}error on "Manual Check" → "Report fraud"/);
  assert.match(stdout, /unreachable from a start: none/);
  assert.match(stdout, /reaches no end: none/);
});

test('explain names a node that genuinely cannot run', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'treadle-cli-'));
  await writeFile(
    join(scratch, 'orphan.bpmn'),
    `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="s" name="Start"><bpmn:outgoing>f</bpmn:outgoing></bpmn:startEvent>
    <bpmn:endEvent id="e" name="End"><bpmn:incoming>f</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f" sourceRef="s" targetRef="e" />
    <bpmn:task id="lost" name="Never runs" />
  </bpmn:process>
</bpmn:definitions>`,
  );

  const { stdout } = await treadle(['explain', 'orphan.bpmn'], { cwd: scratch });

  assert.match(stdout, /unreachable from a start: Never runs/);
  assert.match(stdout, /reaches no end: none/);
});

test('explain is deterministic: the same file twice gives the same bytes', async () => {
  const [first, second] = await Promise.all([
    treadle(['explain', 'miwg/C.4.0.bpmn']),
    treadle(['explain', 'miwg/C.4.0.bpmn']),
  ]);

  assert.equal(first.stdout, second.stdout);
});

test('no read-only command writes anything', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'treadle-cli-'));
  await cp(join(CORPUS, 'handmade/zeebe-roundtrip.bpmn'), join(scratch, 'p.bpmn'));
  const before = await readFile(join(scratch, 'p.bpmn'));

  for (const command of ['project', 'lint', 'explain']) {
    await treadle([command, 'p.bpmn'], { cwd: scratch });
  }

  const after = await readFile(join(scratch, 'p.bpmn'));
  assert.deepEqual(await readdir(scratch), ['p.bpmn']);
  assert.ok(before.equals(after));
});

test('usage errors exit 2 and say what is available', async () => {
  for (const args of [[], ['wat', 'x.bpmn'], ['project']]) {
    const { code, stdout, stderr } = await treadle(args);
    assert.equal(code, 2, args.join(' '));
    assert.match(stdout + stderr, /project.*lint.*explain/s, args.join(' '));
  }
});

test('a path outside the workspace is refused with the flag that widens it', async () => {
  const { code, stderr } = await treadle(['project', '../../package.json'], { cwd: CORPUS });

  assert.equal(code, 2);
  assert.match(stderr, /outside the workspace/);
  assert.match(stderr, /--root/);
});

test('a missing file fails without a stack trace', async () => {
  const { code, stderr } = await treadle(['project', 'nope.bpmn']);

  assert.equal(code, 2);
  assert.match(stderr, /nope\.bpmn/);
  assert.doesNotMatch(stderr, /at .*\.mjs:\d+/);
});

test('an unknown flag exits 2 and says so before touching any file', async () => {
  const { code, stderr } = await treadle(['project', 'handmade/zeebe-roundtrip.bpmn', '--nope']);

  assert.equal(code, 2);
  assert.match(stderr, /--nope/);
  assert.match(stderr, /project.*lint.*explain/s);
});

test('lint prints the validator messages for a file the schema rejects', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'treadle-cli-'));
  await writeFile(
    join(scratch, 'bad.bpmn'),
    '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"/>',
  );

  const { code, stdout } = await treadle(['lint', 'bad.bpmn'], { cwd: scratch });

  assert.equal(code, 1);
  assert.match(stdout, /fail +xsdValid/);
  assert.match(stdout, /targetNamespace/);
});
