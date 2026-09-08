import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { confine, readBpmn, writeBpmnAtomic } from '../../io/bpmn-file.mjs';
import { readFixture } from '../support/fixture.mjs';

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'treadle-io-'));
  const target = join(root, 'process.bpmn');
  const xml = await readFixture();
  await writeFile(target, xml);
  return { root, target, xml };
}

const leftovers = async (root) => (await readdir(root)).filter((name) => name.endsWith('.tmp'));

test('reading a confined file gives back its bytes and its parsed tree', async () => {
  const { root, target, xml } = await workspace();
  const { xml: read, document } = await readBpmn(target, { root });

  assert.equal(read, xml);
  assert.equal(document.definitions.$type, 'bpmn:Definitions');
});

test('a path escaping the root is refused before anything is read', async () => {
  const { root } = await workspace();
  const outside = join(root, '..', 'escape.bpmn');
  await writeFile(outside, '<nope/>');

  await assert.rejects(readBpmn(outside, { root }), (error) => {
    assert.equal(error.code, 'path-outside-root');
    assert.match(error.message, /outside the workspace/);
    return true;
  });
  await assert.rejects(readBpmn(join(root, '..', 'escape.bpmn'), { root }), /outside the workspace/);
});

test('a symlink pointing out of the root is refused too', async () => {
  const { root } = await workspace();
  const outside = join(root, '..', 'linked.bpmn');
  await writeFile(outside, '<nope/>');
  const link = join(root, 'link.bpmn');
  await symlink(outside, link);

  await assert.rejects(readBpmn(link, { root }), /outside the workspace/);
});

test('confine resolves to the real path, which is what the check ran against', async () => {
  const { root, target } = await workspace();
  const realRoot = await realpath(root);

  assert.equal(await confine(root, target), join(realRoot, 'process.bpmn'));
  assert.equal(await confine(root, root), realRoot);
  assert.equal(await confine(root, 'process.bpmn'), join(realRoot, 'process.bpmn'));
});

test('an atomic write replaces the file and leaves no temporary behind', async () => {
  const { root, target, xml } = await workspace();
  const next = xml.replace('Charge card', 'Charge the card');

  await writeBpmnAtomic(target, next, { root });

  assert.equal(await readFile(target, 'utf8'), next);
  assert.deepEqual(await leftovers(root), []);
});

test('every failure path leaves the target byte-identical and the directory clean', async () => {
  const cases = [
    ['unparseable output', '<bpmn:definitions', /Refusing to write/],
    ['empty output', '', /Refusing to write/],
  ];

  for (const [what, bad, expected] of cases) {
    const { root, target, xml } = await workspace();
    await assert.rejects(writeBpmnAtomic(target, bad, { root }), expected, what);

    assert.equal(await readFile(target, 'utf8'), xml, what);
    assert.deepEqual(await leftovers(root), [], what);
  }
});

test('a write outside the root never reaches the filesystem', async () => {
  const { root } = await workspace();
  const outside = join(root, '..', 'written.bpmn');

  await assert.rejects(writeBpmnAtomic(outside, await readFixture(), { root }), /outside the workspace/);
  await assert.rejects(readFile(outside, 'utf8'), /ENOENT/);
});

test('a rename that fails still cleans up its temporary file', async () => {
  const { root, target, xml } = await workspace();
  // Renaming over a directory fails on every platform we support.
  const blocked = join(root, 'blocked.bpmn');
  await mkdir(blocked);

  await assert.rejects(writeBpmnAtomic(blocked, xml, { root }));

  assert.deepEqual(await leftovers(root), []);
  assert.equal(await readFile(target, 'utf8'), xml);
});

test('a path whose parent is a file, not a directory, is refused as such', async () => {
  const { root, target } = await workspace();

  // Platforms can return ENOENT or ENOTDIR for a child under a file. Confinement must
  // distinguish this from an absent write target and consistently refuse the invalid parent.
  await assert.rejects(confine(root, join(target, 'child.bpmn')), (error) => {
    assert.equal(error.code, 'ENOTDIR');
    return true;
  });
});

test('a directory sitting where the temporary goes fails loudly and is not deleted', async () => {
  const { root, target, xml } = await workspace();
  const squatter = join(root, `.process.bpmn.${process.pid}.tmp`);
  await mkdir(squatter);

  await assert.rejects(writeBpmnAtomic(target, xml, { root }));

  // The cleanup is best effort: it must not turn a real error into a confusing one, and it must
  // not remove something this write did not create.
  assert.deepEqual(await readdir(squatter), []);
  assert.equal(await readFile(target, 'utf8'), xml);
});

test('confinement rejects a file parent when realpath reports Windows ENOENT semantics', async (context) => {
  const { root, target, xml } = await workspace();
  const child = join(target, 'child.bpmn');
  const originalRealpath = fs.realpath;
  const failure = Object.assign(new Error('Missing child'), { code: 'ENOENT' });
  const mocked = context.mock.method(fs, 'realpath', async (path) => {
    if (path === child) throw failure;
    return originalRealpath(path);
  });
  syncBuiltinESMExports();
  context.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });

  await assert.rejects(confine(root, child), { code: 'ENOTDIR', cause: failure });
  await assert.rejects(writeBpmnAtomic(child, xml, { root }), { code: 'ENOTDIR' });
  assert.equal(await readFile(target, 'utf8'), xml);
  assert.deepEqual(await leftovers(root), []);
});

test('confinement propagates realpath failures that do not mean a missing leaf', async (context) => {
  const { root, target } = await workspace();
  const failure = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
  const mocked = context.mock.method(fs, 'realpath', async () => { throw failure; });
  syncBuiltinESMExports();
  context.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });

  await assert.rejects(confine(root, target), (error) => error === failure);
});

test('an absent file under a real directory can be confined and created atomically', async () => {
  const { root, xml } = await workspace();
  const target = join(root, 'created.bpmn');
  assert.equal(await confine(root, target), join(await realpath(root), 'created.bpmn'));

  await writeBpmnAtomic(target, xml, { root });

  assert.equal(await readFile(target, 'utf8'), xml);
  assert.deepEqual(await leftovers(root), []);
});
