import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path, { join, posix, win32 } from 'node:path';
import { test } from 'node:test';

import { parse } from '../../core/document.mjs';
import { CODES, TherbligError, fail } from '../../io/errors.mjs';
import { assertSafe, expectedFromOps } from '../../io/guard.mjs';
import { confine, resolveRoot, within } from '../../io/paths.mjs';
import { readWithRev, revOf } from '../../io/rev.mjs';
import { parses, schemaDir, xsdValid } from '../../io/validate.mjs';
import { applyToFile, atomicWrite } from '../../io/write.mjs';
import { readFixture } from '../support/fixture.mjs';

async function workspace(t) {
  const root = await fsp.mkdtemp(join(tmpdir(), 'therblig-io-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const target = join(root, 'process.bpmn');
  const xml = await readFixture();
  await fsp.writeFile(target, xml);
  return { root, target, xml };
}

function fault(t, object, method, implementation) {
  const mocked = t.mock.method(object, method, implementation);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return mocked;
}

test('error codes retain recovery text and normalize details without losing the code', () => {
  for (const code of Object.keys(CODES)) {
    const error = new TherbligError(code);
    assert.equal(error.name, 'TherbligError');
    assert.equal(error.detail, null);
    assert.deepEqual(error.toResult(), { ok: false, code, error: CODES[code] });
  }
  for (const detail of ['Missing node', ' Missing node. ', 'Missing node!', 'Missing node?']) {
    const error = new TherbligError('THB_NOT_FOUND_ELEMENT', detail);
    assert.equal(error.detail, detail);
    assert.match(error.message, /^Missing node[.!?] No element/);
  }
  assert.throws(() => new TherbligError('invented'), /unknown error code/);
  assert.throws(() => fail('THB_NOT_FOUND', 'Missing file'), { code: 'THB_NOT_FOUND' });
});

test('roots resolve once and refuse missing, filesystem-root and home grants', async (t) => {
  const { root } = await workspace(t);
  const link = join(root, 'linked-root');
  await fsp.mkdir(join(root, 'project'));
  await fsp.symlink(join(root, 'project'), link);
  assert.equal(await resolveRoot(link), await fsp.realpath(join(root, 'project')));
  assert.equal(await resolveRoot(), await fsp.realpath(process.cwd()));
  await assert.rejects(resolveRoot(join(root, 'missing')), { code: 'THB_NOT_FOUND' });
  await assert.rejects(resolveRoot(path.parse(root).root), { code: 'THB_OUTSIDE_ROOT' });
  await assert.rejects(resolveRoot(homedir()), { code: 'THB_OUTSIDE_ROOT' });
});

test('path confinement permits BPMN/XML within the real root and rejects probes and escapes', async (t) => {
  const { root, target } = await workspace(t);
  const inner = join(root, 'project');
  await fsp.mkdir(inner);
  const inside = join(inner, 'inside.XML');
  await fsp.writeFile(inside, '<a/>');
  await fsp.symlink(inside, join(inner, 'inside-link.bpmn'));
  await fsp.symlink(target, join(inner, 'escape.bpmn'));
  assert.equal(await confine(inner, 'inside.XML'), await fsp.realpath(inside));
  assert.equal(await confine(inner, inside), await fsp.realpath(inside));
  assert.equal(await confine(inner, 'inside-link.bpmn'), await fsp.realpath(inside));
  for (const candidate of [null, 12, '', '  ']) {
    await assert.rejects(confine(inner, candidate), { code: 'THB_NOT_FOUND' });
  }
  await assert.rejects(confine(inner, '../private.key'), { code: 'THB_NOT_BPMN' });
  await assert.rejects(confine(inner, 'missing.bpmn'), { code: 'THB_NOT_FOUND' });
  for (const candidate of [target, '../process.bpmn', 'escape.bpmn']) {
    await assert.rejects(confine(inner, candidate), { code: 'THB_OUTSIDE_ROOT' });
  }
});

test('containment uses actual POSIX and Windows path semantics, including case and drives', () => {
  assert.equal(within('/project', '/project/file.bpmn'), true);
  assert.equal(within('/project', '/project', posix), false);
  assert.equal(within('/project/sub', '/project', posix), false);
  assert.equal(within('/project', '/project-copy/file.bpmn', posix), false);
  assert.equal(within('C:\\Project', 'c:\\project\\File.bpmn', win32), true);
  assert.equal(within('C:\\Project', 'D:\\Project\\File.bpmn', win32), false);
  assert.equal(within('C:\\Project', 'C:\\Other\\File.bpmn', win32), false);
});

test('validation uses the bundled schemas and distinguishes XML parse and XSD failures', async () => {
  const xml = await readFixture();
  const parsed = await parses(xml);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.root.$type, 'bpmn:Definitions');
  assert.equal(typeof parsed.warnings, 'number');
  const malformed = await parses('<bpmn:definitions');
  assert.equal(malformed.ok, false);
  assert.ok(malformed.error.length <= 207);
  assert.ok(fs.existsSync(join(schemaDir(), 'BPMN20.xsd')));
  assert.deepEqual(await xsdValid(xml), { ok: true, errors: [] });
  const invalid = await xsdValid('<a/>');
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.length > 0);
  assert.ok(invalid.errors.every((error) => typeof error === 'string' && error.length > 0));
});

test('schema read failures fail validation closed with a bounded diagnostic', async (t) => {
  const read = fs.readFileSync;
  fault(t, fs, 'readFileSync', (file, ...args) => {
    if (String(file).endsWith('BPMN20.xsd')) throw new Error('schema unavailable '.repeat(50));
    return read(file, ...args);
  });
  const result = await xsdValid('<a/>');
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^validator error: schema unavailable/);
  assert.equal(result.errors[0].length, 'validator error: '.length + 200);
});

test('the write guard includes attached event cascades while retaining unrelated protection', async () => {
  const tree = (await parse(await readFixture())).definitions;
  const noChange = assertSafe(tree, tree);
  assert.equal(noChange.ok, true);
  const host = { id: 'Host', $type: 'bpmn:Task' };
  const boundary = { id: 'Boundary', $type: 'bpmn:BoundaryEvent', attachedToRef: host };
  const nested = { id: 'Nested', $type: 'bpmn:BoundaryEvent', attachedToRef: boundary };
  const eventDefinition = { id: 'Timer', $type: 'bpmn:TimerEventDefinition' };
  boundary.eventDefinitions = [eventDefinition];
  const definitions = {
    elements: [nested, boundary, host,
      { id: 'BoundaryFlow', sourceRef: boundary },
      { id: 'Incoming', targetRef: host },
      { id: 'Lane', $type: 'bpmn:Lane', flowNodeRef: [null, host] },
      { id: 'EmptyLane', $type: 'bpmn:Lane' },
      { id: 'Unrelated', $type: 'bpmn:Task' }],
  };
  const expected = expectedFromOps([{ op: 'del', id: 'Host', between: [null, 'Named'] }], definitions, ['New']);
  for (const id of ['Host', 'Boundary', 'Nested', 'Timer', 'BoundaryFlow', 'Incoming', 'Lane', 'Named', 'New']) {
    assert.ok(expected.has(id), id);
  }
  assert.equal(expected.has('Unrelated'), false);
  assert.equal(expected.has('EmptyLane'), false);
});

test('file patching preserves bytes on errors and maps core refusals to actionable codes', async (t) => {
  const { target, xml } = await workspace(t);
  const cases = [
    [{ op: 'set', id: 'Charge', patch: { incoming: [] } }, 'THB_FORBIDDEN_FIELD'],
    [{ op: 'set', id: 'Charge', patch: { colour: 'red' } }, 'THB_FORBIDDEN_FIELD'],
    [{ op: 'set', id: 'Missing', patch: { name: 'x' } }, 'THB_NOT_FOUND_ELEMENT'],
    [{ op: 'teleport', id: 'Charge' }, 'THB_UNKNOWN_TYPE'],
    [{ op: 'add', in: 'Payment', type: 'invented' }, 'THB_UNKNOWN_TYPE'],
  ];
  for (const [op, code] of cases) {
    await assert.rejects(applyToFile(target, [op], { dryRun: true }), { code });
    assert.equal(await fsp.readFile(target, 'utf8'), xml);
  }
  await assert.rejects(applyToFile(target, []), { code: 'THB_REV_REQUIRED' });
  await assert.rejects(applyToFile(target, [], { baseRev: 'stale' }), { code: 'THB_STALE_REV' });
  await assert.rejects(applyToFile(target, [], { dryRun: true, baseRev: 'stale' }), { code: 'THB_STALE_REV' });
});

test('previews and committed writes retain revisions and validate the actual saved bytes', async (t) => {
  const { target, xml } = await workspace(t);
  const { rev } = await readWithRev(target);
  assert.equal(rev, revOf(xml));
  const ops = [{ op: 'set', id: 'Charge', patch: { name: 'Charge the card' } }];
  const preview = await applyToFile(target, ops, { dryRun: true, baseRev: rev });
  assert.equal(preview.refused, false);
  assert.equal(preview.written, false);
  assert.equal(await fsp.readFile(target, 'utf8'), xml);
  const written = await applyToFile(target, ops, { baseRev: rev });
  assert.equal(written.written, true);
  assert.equal(written.new_rev, revOf(await fsp.readFile(target)));
  assert.equal((await xsdValid(await fsp.readFile(target, 'utf8'))).ok, true);
});

test('atomic writes clean temporary files after a real rename failure', async (t) => {
  const { root, target, xml } = await workspace(t);
  const directory = join(root, 'directory.bpmn');
  await fsp.mkdir(directory);
  await assert.rejects(atomicWrite(directory, 'replacement'));
  assert.equal(await fsp.readFile(target, 'utf8'), xml);
  assert.deepEqual((await fsp.readdir(root)).filter((name) => name.endsWith('.tmp')), []);
});

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`atomic writes retry transient ${code} without changing the target before rename`, async (t) => {
    const { root, target, xml } = await workspace(t);
    const rename = fsp.rename;
    let attempts = 0;
    fault(t, fsp, 'rename', async (...args) => {
      attempts++;
      if (attempts === 1) {
        assert.equal(await fsp.readFile(target, 'utf8'), xml);
        throw Object.assign(new Error('temporarily locked'), { code });
      }
      return rename(...args);
    });
    await atomicWrite(target, 'replacement', { retries: 1 });
    assert.equal(attempts, 2);
    assert.equal(await fsp.readFile(target, 'utf8'), 'replacement');
    assert.deepEqual((await fsp.readdir(root)).filter((name) => name.endsWith('.tmp')), []);
  });
}

test('exhausted rename retries retain the original file even if temp cleanup also fails', async (t) => {
  const { target, xml } = await workspace(t);
  const failure = Object.assign(new Error('locked'), { code: 'EBUSY' });
  const rename = fault(t, fsp, 'rename', async () => { throw failure; });
  const unlink = fault(t, fsp, 'unlink', async () => { throw new Error('cleanup denied'); });
  await assert.rejects(atomicWrite(target, 'replacement', { retries: 0 }), (error) => error === failure);
  assert.equal(rename.mock.callCount(), 1);
  assert.equal(unlink.mock.callCount(), 1);
  assert.equal(await fsp.readFile(target, 'utf8'), xml);
});
