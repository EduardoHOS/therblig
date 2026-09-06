import { readFile } from 'node:fs/promises';

const CORPUS_ROOT = new URL('../../../bench/corpus/', import.meta.url);

export async function readFixture(relativePath = 'handmade/zeebe-roundtrip.bpmn') {
  return readFile(new URL(relativePath, CORPUS_ROOT), 'utf8');
}

export async function normalizedFixture(relativePath) {
  const { parse, serialize } = await import('../../core/index.mjs');
  const original = await readFixture(relativePath);
  const document = await parse(original);
  return { document, original, normalized: await serialize(document) };
}
