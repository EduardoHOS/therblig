import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

import { parse, project, serialize } from '../../core/index.mjs';

const CORPUS_ROOT = new URL('../../../bench/corpus/', import.meta.url);

async function bpmnFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) return bpmnFiles(url);
      return entry.name.endsWith('.bpmn') ? [url] : [];
    }),
  );
  return nested.flat();
}

test('the functional core round-trips and projects every corpus document', async () => {
  const files = await bpmnFiles(CORPUS_ROOT);
  assert.equal(files.length, 22);

  for (const file of files) {
    const xml = await readFile(file, 'utf8');
    const document = await parse(xml);
    const projection = project(document.definitions);
    const serialized = await serialize(document);
    const reparsed = await parse(serialized);

    assert.ok(projection.processes?.length || projection.pools?.length, file.pathname);
    assert.equal(reparsed.definitions.$type, 'bpmn:Definitions', file.pathname);
  }
});
