import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZip, readZip, crc32 } from '@elabora/node/zip';

test('crc32 matches the reference value', () => {
  assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
});

test('ZIP output is deterministic and readable', () => {
  const files = new Map([['b.txt', Buffer.from('bbbb'.repeat(100))], ['a/x.json', Buffer.from('{"a":1}')], ['img.png', Buffer.from([1, 2, 3])]]);
  const one = createZip(files).zip;
  const two = createZip(new Map([...files].reverse())).zip;
  assert.ok(one.equals(two));
  const back = readZip(one);
  assert.deepEqual([...back.files.keys()], ['a/x.json', 'b.txt', 'img.png']);
  assert.deepEqual(back.files, files);
  assert.equal(back.meta.find((m) => m.name === 'img.png')?.method, 0);
  assert.equal(back.meta.find((m) => m.name === 'b.txt')?.method, 8);
});
