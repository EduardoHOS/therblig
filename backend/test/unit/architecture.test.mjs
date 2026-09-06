import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

const CORE_ROOT = new URL('../../core/', import.meta.url);

test('only adjacency.mjs directly assigns BPMN graph references', async () => {
  const files = (await readdir(CORE_ROOT)).filter(
    (file) => file.endsWith('.mjs') && file !== 'adjacency.mjs',
  );

  for (const file of files) {
    const source = await readFile(new URL(file, CORE_ROOT), 'utf8');
    assert.doesNotMatch(source, /\.(?:sourceRef|targetRef)\s*=(?!=)/, file);
    assert.doesNotMatch(source, /\.(?:incoming|outgoing)\s*=(?!=)/, file);
  }
});

test('ops.mjs compiles intent to primitives without touching the parser or the tree', async () => {
  const source = await readFile(new URL('ops.mjs', CORE_ROOT), 'utf8');
  assert.doesNotMatch(source, /from '\.\/document\.mjs'/);
  assert.doesNotMatch(source, /from 'bpmn-moddle'/);
  assert.doesNotMatch(source, /moddle\.create/);
});

test('a node type is named in blocks/ and nowhere else in the core', async () => {
  const { blocks } = await import('../../core/registry.mjs');
  const types = blocks.flatMap((block) => [block.bpmn, ...(block.also ?? [])]);
  const files = (await readdir(CORE_ROOT)).filter((file) => file.endsWith('.mjs'));

  for (const file of files) {
    const source = await readFile(new URL(file, CORE_ROOT), 'utf8');
    for (const type of types) {
      assert.doesNotMatch(source, new RegExp(`['"\`]${type}['"\`]`), `${file} names ${type}`);
    }
  }
});

test('the core never reaches the filesystem; backend/io is the only place that does', async () => {
  // gates.mjs reads the vendored OMG schemas, which ship with the module and are not user input.
  const VENDORED_SCHEMAS = new Set(['gates.mjs']);
  const files = (await readdir(CORE_ROOT, { recursive: true })).filter((file) =>
    file.endsWith('.mjs'),
  );

  for (const file of files) {
    const source = await readFile(new URL(file, CORE_ROOT), 'utf8');
    if (!VENDORED_SCHEMAS.has(file)) assert.doesNotMatch(source, /from 'node:fs/, file);
    assert.doesNotMatch(source, /from '\.\.\/io\//, file);
  }
});
