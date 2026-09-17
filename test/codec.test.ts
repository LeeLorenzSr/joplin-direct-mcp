import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parseItem, serializeItem } from '../src/codec.js';
import type { JoplinItem } from '../src/contracts.js';

const id = '0123456789abcdef0123456789abcdef';

test('v3.7.18 source-shaped fixtures parse and serialize canonically', async () => {
  const note = await readFile(join(process.cwd(), 'test', 'fixtures', 'v3.7.18-note.md'), 'utf8');
  const tag = await readFile(join(process.cwd(), 'test', 'fixtures', 'v3.7.18-note-tag.md'), 'utf8');
  // Patch fixtures are line terminated by the repository editor; the wire
  // format itself has no trailing newline, so remove that editor terminator.
  assert.equal(serializeItem(parseItem(note.replace(/\r?\n$/, ''))), note.replace(/\r?\n$/, ''));
  assert.equal(serializeItem(parseItem(tag.replace(/\r?\n$/, ''))), tag.replace(/\r?\n$/, ''));
});

test('plaintext codec preserves body newlines and unknown properties', () => {
  const item: JoplinItem = {
    id,
    type_: 1,
    title: 'A title',
    body: 'first\r\nsecond\n\nthird\n',
    properties: {
      parent_id: 'fedcba9876543210fedcba9876543210',
      custom_field: 'literal\\n plus\ncarriage\r',
    },
  };
  const raw = serializeItem(item);
  assert.deepEqual(parseItem(raw), item);
  assert.equal(raw, `A title\n\nfirst\r\nsecond\n\nthird\n\n\nid: ${id}\nparent_id: fedcba9876543210fedcba9876543210\ncustom_field: literal\\\\n plus\\ncarriage\\r\ntype_: 1`);
});

test('empty note body follows BaseItem serialization and has no trailing newline', () => {
  const item: JoplinItem = { id, type_: 1, title: '', body: '', properties: {} };
  const raw = serializeItem(item);
  assert.equal(raw, `\n\nid: ${id}\ntype_: 1`);
  assert.deepEqual(parseItem(raw), item);
  assert.equal(raw.endsWith('\n'), false);
});

test('codec accepts inventory-only master key and revision records for safe gating', () => {
  for (const type_ of [2, 4, 5, 6, 9, 13]) {
    const metadataOnly = [6, 9, 13].includes(type_);
    const item: JoplinItem = { id, type_, title: metadataOnly ? '' : 'item', body: '', properties: { unknown: 'kept' } };
    assert.deepEqual(parseItem(serializeItem(item)), item);
  }
});

test('codec rejects malformed, encrypted-looking, and unsupported records', () => {
  assert.throws(() => parseItem('title\n\nnot metadata'), /Malformed/);
  assert.throws(() => parseItem(`title\n\nid: ${id}\ntype_: 3`), /unsupported/);
  assert.throws(() => parseItem(`title\n\nid: ../../escape\ntype_: 1`), /invalid id/);
  assert.throws(() => parseItem(`title\n\nbody\nid: ${id}\ntype_: 1`), /property|expected/);
  assert.throws(() => serializeItem({ id, type_: 2, title: 'folder', body: 'unexpected', properties: {} }), /non-note/);
});
