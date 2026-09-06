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
