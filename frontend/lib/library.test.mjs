import assert from 'node:assert/strict';
import { test } from 'node:test';

import { comparisonHref, fileDetails, folders, processHref, selectFiles } from './library.mjs';

const files = Object.freeze([
  Object.freeze({ path: 'sales/order-10.bpmn', nodes: 12, pools: 1, bytes: 2048 }),
  Object.freeze({ path: 'root.bpmn', nodes: 0, pools: 0, bytes: 0 }),
  Object.freeze({ path: 'sales/order-2.bpmn', nodes: 3, pools: 0, bytes: 1024 }),
  Object.freeze({ path: 'sales/archive/Áprovação.bpmn', nodes: 12, pools: 2, bytes: 512 }),
]);

test('file details keep the real filename and separate its containing directory', () => {
  assert.deepEqual(fileDetails(files[0]), { name: 'order-10.bpmn', folder: 'sales', size: '2 kB' });
  assert.deepEqual(fileDetails(files[1]), { name: 'root.bpmn', folder: '', size: '0 B' });
  assert.equal(fileDetails(files[2]).size, '1 kB');
  assert.equal(fileDetails(files[3]).size, '512 B');
});

test('folder counts include direct files only and preserve the root directory', () => {
  assert.deepEqual(folders(files), [
    { path: '', count: 1 },
    { path: 'sales', count: 2 },
    { path: 'sales/archive', count: 1 },
  ]);
  assert.deepEqual(folders([]), []);
});

test('search trims whitespace and matches case and accents across names and directories', () => {
  assert.deepEqual(selectFiles(files, '  APROVACAO  ', null, 'name'), [files[3]]);
  assert.equal(selectFiles(files, 'sales', null, 'name').length, 3);
  assert.deepEqual(selectFiles(files, 'missing', null, 'name'), []);
  assert.deepEqual(selectFiles([], '', null, 'name'), []);
});

test('folder selection composes with search and distinguishes root from all files', () => {
  assert.deepEqual(selectFiles(files, '', '', 'name'), [files[1]]);
  assert.deepEqual(selectFiles(files, '10', 'sales', 'name'), [files[0]]);
  assert.equal(selectFiles(files, '', 'sales', 'name').length, 2);
  assert.deepEqual(selectFiles(files, '', 'missing', 'name'), []);
});

test('sorts naturally by filename with the full path breaking duplicate-name ties', () => {
  assert.deepEqual(selectFiles(files, '', null, 'name'), [files[3], files[2], files[0], files[1]]);
  const duplicates = [{ ...files[0], path: 'z/same.bpmn' }, { ...files[0], path: 'a/same.bpmn' }];
  assert.equal(selectFiles(duplicates, '', null, 'name')[0].path, 'a/same.bpmn');
});

test('sorts elements and file size descending with stable name tie-breaking, without mutating input', () => {
  assert.deepEqual(selectFiles(files, '', null, 'elements'), [files[3], files[0], files[2], files[1]]);
  assert.deepEqual(selectFiles(files, '', null, 'size'), [files[0], files[2], files[3], files[1]]);
  const sameSize = [{ ...files[0], path: 'z.bpmn' }, { ...files[0], path: 'a.bpmn' }];
  assert.equal(selectFiles(sameSize, '', null, 'size')[0].path, 'a.bpmn');
  assert.equal(files[0].path, 'sales/order-10.bpmn');
});

test('process URLs encode individual segments, preserving literal percent, hash and question marks', () => {
  assert.equal(processHref('sales/50% #1?.bpmn'), '/p/sales/50%25%20%231%3F.bpmn');
  assert.equal(processHref('Á.bpmn'), '/p/%C3%81.bpmn');
  const encoded = new URL(processHref('vendas/Base 50% #1?.bpmn'), 'http://localhost').pathname;
  assert.equal(encoded.slice(3).split('/').map(decodeURIComponent).join('/'), 'vendas/Base 50% #1?.bpmn');
});

test('comparisons require two distinct listed files and point from baseline to proposal', () => {
  assert.equal(comparisonHref(files, '', ''), null);
  assert.equal(comparisonHref(files, files[0].path, ''), null);
  assert.equal(comparisonHref(files, 'missing', files[0].path), null);
  assert.equal(comparisonHref(files, files[0].path, 'missing'), null);
  assert.equal(comparisonHref(files, files[0].path, files[0].path), null);
  assert.equal(comparisonHref(files, files[1].path, files[0].path), '/p/sales/order-10.bpmn?against=root.bpmn');
  const special = [{ ...files[0], path: 'folder/base #1%.bpmn' }, { ...files[1], path: 'new?.bpmn' }];
  const result = new URL(comparisonHref(special, special[0].path, special[1].path), 'http://localhost');
  assert.equal(result.pathname, '/p/new%3F.bpmn');
  assert.equal(result.searchParams.get('against'), special[0].path);
});
