import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JoplinClient } from '../src/client.js';
import { parseItem, serializeItem } from '../src/codec.js';
import type { ClientConfig, JoplinItem, ServerTransport } from '../src/contracts.js';

const ids = {
  notebook: '11111111111111111111111111111111',
  otherNotebook: '22222222222222222222222222222222',
  note: '33333333333333333333333333333333',
  otherNote: '44444444444444444444444444444444',
  lockedNote: '55555555555555555555555555555555',
  encryptedNote: '66666666666666666666666666666666',
  tag: '77777777777777777777777777777777',
  link: '88888888888888888888888888888888',
} as const;

const item = (id: string, type_: number, title: string, body = '', properties: Record<string, string> = {}): JoplinItem => ({
  id, type_, title, body,
  properties: { created_time: '2026-09-17T12:00:00.000Z', updated_time: '2026-09-17T12:00:00.000Z', ...(type_ === 1 ? { markup_language: '1' } : {}), ...properties },
});

class MemoryTransport implements ServerTransport {
  readonly files = new Map<string, Uint8Array>();
  putCount = 0;
  deleteCount = 0;
  failGetName: string | null = null;
  loseNextPutResponse = false;

  constructor(items: JoplinItem[], info: Record<string, unknown> = { version: 3, e2ee: { value: false } }) {
    this.files.set('info.json', new TextEncoder().encode(JSON.stringify(info)));
    for (const value of items) this.files.set(`${value.id}.md`, new TextEncoder().encode(serializeItem(value)));
  }

  listItems(): Promise<{ items: { name: string }[]; has_more: boolean }> {
    return Promise.resolve({ items: [...this.files.keys()].map(name => ({ name })), has_more: false });
  }

  getContent(name: string): Promise<Uint8Array | null> {
    if (this.failGetName === name) return Promise.reject(new Error(`fixture read failure: ${name}`));
    const value = this.files.get(name);
    return Promise.resolve(value ? new Uint8Array(value) : null);
  }

  putContent(name: string, content: Uint8Array): Promise<void> {
    this.putCount++;
    this.files.set(name, new Uint8Array(content));
    if (this.loseNextPutResponse) {
      this.loseNextPutResponse = false;
      return Promise.reject(new Error('connection lost after server accepted PUT'));
    }
    return Promise.resolve();
  }

  deleteItem(name: string): Promise<void> {
    this.deleteCount++;
    this.files.delete(name);
    return Promise.resolve();
  }

  readItem(id: string): JoplinItem {
    return parseItem(new TextDecoder().decode(this.files.get(`${id}.md`)));
  }
}

const config = (stateDir: string, overrides: Partial<ClientConfig> = {}): ClientConfig => ({
  serverUrl: 'https://fixture.example.test', email: 'agent@example.test', password: 'secret', stateDir,
  allowInsecureLocalhost: false, readOnly: true, allowedNotebookIds: null, requestTimeoutMs: 5000, ...overrides,
});

const basicItems = (): JoplinItem[] => [
  item(ids.notebook, 2, 'Work', '', { parent_id: '', deleted_time: '0' }),
  item(ids.otherNotebook, 2, 'Private', '', { parent_id: '', deleted_time: '0' }),
  item(ids.note, 1, 'Router', 'Configure the router', { parent_id: ids.notebook, deleted_time: '0', is_conflict: '0', encryption_applied: '0' }),
  item(ids.otherNote, 1, 'Router secret', 'Other notebook', { parent_id: ids.otherNotebook, deleted_time: '0', is_conflict: '0', encryption_applied: '0' }),
  item(ids.tag, 5, 'infra'),
  item(ids.link, 6, '', '', { note_id: ids.note, tag_id: ids.tag }),
];

async function withState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), 'joplin-client-test-'));
  try { return await fn(stateDir); } finally { await rm(stateDir, { recursive: true, force: true }); }
}

test('read-only mode blocks every write while allowing preview', async () => withState(async stateDir => {
  const transport = new MemoryTransport(basicItems());
  const client = new JoplinClient(config(stateDir), transport);
  await client.sync();
  const plan = await client.previewChanges([{ kind: 'update_note', noteId: ids.note, expectedRevision: (await client.getNote(ids.note) as { revision: string }).revision, patch: { title: 'Changed' } }]) as { planId: string };
  await assert.rejects(client.applyChanges(plan.planId), /Writes are disabled/);
  assert.equal(transport.putCount, 0);
  await client.close();
}));

test('notebook allowlists apply to reads, tags, and writes', async () => withState(async stateDir => {
  const transport = new MemoryTransport(basicItems());
  const client = new JoplinClient(config(stateDir, { allowedNotebookIds: [ids.notebook] }), transport);
  assert.deepEqual((await client.listNotebooks() as { id: string }[]).map(value => value.id), [ids.notebook]);
  assert.equal((await client.searchNotes({ query: 'router' }) as { total: number }).total, 1);
  await assert.rejects(client.getNote(ids.otherNote), /unavailable|scope/);
  assert.deepEqual((await client.listTags() as { id: string }[]).map(value => value.id), [ids.tag]);
  await client.close();
}));

test('failed refresh leaves the last committed snapshot intact', async () => withState(async stateDir => {
  const transport = new MemoryTransport(basicItems());
  const client = new JoplinClient(config(stateDir), transport);
  await client.sync();
  const snapshotPath = join(stateDir, 'snapshot.json');
  const before = await readFile(snapshotPath, 'utf8');
  transport.files.set(`${ids.lockedNote}.md`, new TextEncoder().encode(serializeItem(item(ids.lockedNote, 1, 'new', '', { parent_id: ids.notebook }))));
  transport.failGetName = `${ids.lockedNote}.md`;
  await assert.rejects(client.sync(), /fixture read failure/);
  assert.equal(await readFile(snapshotPath, 'utf8'), before);
  await client.close();
}));

test('a lost PUT response is reconciled by applying the same journaled plan', async () => withState(async stateDir => {
  const transport = new MemoryTransport(basicItems());
  const client = new JoplinClient(config(stateDir, { readOnly: false }), transport);
  const revision = (await client.getNote(ids.note) as { revision: string }).revision;
  const plan = await client.previewChanges([{ kind: 'update_note', noteId: ids.note, expectedRevision: revision, patch: { title: 'Updated once' } }]) as { planId: string };
  transport.loseNextPutResponse = true;
  assert.equal((await client.applyChanges(plan.planId) as { status: string }).status, 'interrupted');
  assert.equal((await client.applyChanges(plan.planId) as { status: string }).status, 'completed');
  assert.equal(transport.putCount, 1);
  assert.equal(transport.readItem(ids.note).title, 'Updated once');
  await client.close();
}));

test('a pending journal survives process restart', async () => withState(async stateDir => {
  const transport = new MemoryTransport(basicItems());
  const first = new JoplinClient(config(stateDir, { readOnly: false }), transport);
  const revision = (await first.getNote(ids.note) as { revision: string }).revision;
  const plan = await first.previewChanges([{ kind: 'update_note', noteId: ids.note, expectedRevision: revision, patch: { body: 'after restart' } }]) as { planId: string };
  await first.close();
  const second = new JoplinClient(config(stateDir, { readOnly: false }), transport);
  assert.equal((await second.applyChanges(plan.planId) as { status: string }).status, 'completed');
  assert.equal(second && transport.readItem(ids.note).body, 'after restart');
  await second.close();
}));

test('stale plans are rejected after an external server change', async () => withState(async stateDir => {
  const transport = new MemoryTransport(basicItems());
  const client = new JoplinClient(config(stateDir, { readOnly: false }), transport);
  const revision = (await client.getNote(ids.note) as { revision: string }).revision;
  const plan = await client.previewChanges([{ kind: 'update_note', noteId: ids.note, expectedRevision: revision, patch: { title: 'planned' } }]) as { planId: string };
  const changed = transport.readItem(ids.note); changed.title = 'external'; transport.files.set(`${ids.note}.md`, new TextEncoder().encode(serializeItem(changed)));
  await assert.rejects(client.applyChanges(plan.planId), /conflicts|changed/);
  assert.equal(transport.putCount, 0);
  await client.close();
}));

test('restoration refuses to overwrite an intervening change', async () => withState(async stateDir => {
  const transport = new MemoryTransport(basicItems());
  const client = new JoplinClient(config(stateDir, { readOnly: false }), transport);
  const revision = (await client.getNote(ids.note) as { revision: string }).revision;
  const plan = await client.previewChanges([{ kind: 'update_note', noteId: ids.note, expectedRevision: revision, patch: { title: 'planned' } }]) as { planId: string };
  assert.equal((await client.applyChanges(plan.planId) as { status: string }).status, 'completed');
  const changed = transport.readItem(ids.note); changed.title = 'external'; transport.files.set(`${ids.note}.md`, new TextEncoder().encode(serializeItem(changed)));
  await assert.rejects(client.restoreOperation(plan.planId), /changed after the operation/);
  assert.equal(transport.readItem(ids.note).title, 'external');
  await client.close();
}));

test('unknown item types fail inventory validation instead of being silently interpreted', async () => withState(async stateDir => {
  const transport = new MemoryTransport([]);
  transport.files.set('99999999999999999999999999999999.md', new TextEncoder().encode('future item\n\nid: 99999999999999999999999999999999\ntype_: 99'));
  const client = new JoplinClient(config(stateDir), transport);
  await assert.rejects(client.sync(), /unsupported type_/);
  await client.close();
}));

test('encrypted and locked notes remain unavailable', async () => withState(async stateDir => {
  const encrypted = item(ids.encryptedNote, 1, 'Encrypted', 'ciphertext', { parent_id: ids.notebook, encryption_applied: '1', encryption_cipher_text: 'payload' });
  const locked = item(ids.lockedNote, 1, 'Locked', 'locked body', { parent_id: ids.notebook, is_locked: '1' });
  const client = new JoplinClient(config(stateDir), new MemoryTransport([
    item(ids.notebook, 2, 'Work', '', { parent_id: '', deleted_time: '0' }), encrypted, locked,
  ]));
  assert.equal((await client.searchNotes({ query: 'Encrypted' }) as { total: number }).total, 0);
  await assert.rejects(client.getNote(ids.encryptedNote), /unavailable|scope/);
  await assert.rejects(client.getNote(ids.lockedNote), /unavailable|scope/);
  await client.close();
}));

test('E2EE target capability is rejected before snapshot replacement', async () => withState(async stateDir => {
  const transport = new MemoryTransport(basicItems(), { version: 3, e2ee: { value: true } });
  const client = new JoplinClient(config(stateDir), transport);
  await assert.rejects(client.sync(), /E2EE is enabled/);
  await client.close();
}));
