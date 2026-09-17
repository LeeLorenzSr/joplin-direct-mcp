import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JoplinClient } from '../src/client.js';
import { parseItem, serializeItem } from '../src/codec.js';
import type { ClientConfig, JoplinItem, ServerTransport } from '../src/contracts.js';

const ids = {
  notebook: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  noteOne: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  noteTwo: 'cccccccccccccccccccccccccccccccc',
  otherNotebook: 'dddddddddddddddddddddddddddddddd',
  childNotebook: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
} as const;

const item = (id: string, type_: number, title: string, body = '', properties: Record<string, string> = {}): JoplinItem => ({
  id, type_, title, body,
  properties: { created_time: '1700000000000', updated_time: '1700000000000', ...(type_ === 1 ? { markup_language: '1' } : {}), ...properties },
});

class EdgeTransport implements ServerTransport {
  readonly files = new Map<string, Uint8Array>();
  putCount = 0;
  failPutName: string | null = null;

  constructor(items: JoplinItem[]) {
    this.files.set('info.json', new TextEncoder().encode(JSON.stringify({ version: 3, e2ee: { value: false } })));
    for (const value of items) this.files.set(`${value.id}.md`, new TextEncoder().encode(serializeItem(value)));
  }

  listItems() { return Promise.resolve({ items: [...this.files.keys()].map(name => ({ name })), has_more: false }); }
  getContent(name: string) { const value = this.files.get(name); return Promise.resolve(value ? new Uint8Array(value) : null); }
  putContent(name: string, content: Uint8Array) {
    this.putCount++;
    if (this.failPutName === name) return Promise.reject(new Error(`lost before PUT: ${name}`));
    this.files.set(name, new Uint8Array(content));
    return Promise.resolve();
  }
  deleteItem(name: string) { this.files.delete(name); return Promise.resolve(); }
  read(id: string) { return parseItem(new TextDecoder().decode(this.files.get(`${id}.md`))); }
}

class ServerCanonicalizingTransport extends EdgeTransport {
  override putContent(name: string, content: Uint8Array) {
    const item = parseItem(new TextDecoder().decode(content));
    delete item.properties.is_locked;
    delete item.properties.extracted_resource_ids;
    return super.putContent(name, new TextEncoder().encode(serializeItem(item)));
  }
}

const fixtureItems = () => [
  item(ids.notebook, 2, 'Inbox', '', { parent_id: '', deleted_time: '0' }),
  item(ids.noteOne, 1, 'One', 'original one', { parent_id: ids.notebook, deleted_time: '0', is_conflict: '0', encryption_applied: '0' }),
  item(ids.noteTwo, 1, 'Two', 'original two', { parent_id: ids.notebook, deleted_time: '0', is_conflict: '0', encryption_applied: '0' }),
];

const config = (stateDir: string): ClientConfig => ({
  serverUrl: 'https://fixture.example.test', email: 'agent@example.test', password: 'secret', stateDir,
  allowInsecureLocalhost: false, readOnly: false, allowedNotebookIds: null, requestTimeoutMs: 5000,
});

async function withState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), 'joplin-client-edge-'));
  try { return await fn(stateDir); } finally { await rm(stateDir, { recursive: true, force: true }); }
}

test('one newly created tag is shared by all notes in a multi-note plan', async () => withState(async stateDir => {
  const transport = new EdgeTransport(fixtureItems());
  const client = new JoplinClient(config(stateDir), transport);
  const oneRevision = (await client.getNote(ids.noteOne) as { revision: string }).revision;
  const twoRevision = (await client.getNote(ids.noteTwo) as { revision: string }).revision;
  const plan = await client.previewChanges([
    { kind: 'tag_note', noteId: ids.noteOne, expectedRevision: oneRevision, tagTitle: 'shared' },
    { kind: 'tag_note', noteId: ids.noteTwo, expectedRevision: twoRevision, tagTitle: 'shared' },
  ]) as { writes: { after: JoplinItem | null }[] };
  assert.equal(plan.writes.filter(write => write.after?.type_ === 5).length, 1);
  await client.close();
}));

test('partial multi-action application resumes and restoration is repeat-safe', async () => withState(async stateDir => {
  const transport = new EdgeTransport(fixtureItems());
  const client = new JoplinClient(config(stateDir), transport);
  const oneRevision = (await client.getNote(ids.noteOne) as { revision: string }).revision;
  const twoRevision = (await client.getNote(ids.noteTwo) as { revision: string }).revision;
  const plan = await client.previewChanges([
    { kind: 'update_note', noteId: ids.noteOne, expectedRevision: oneRevision, patch: { body: 'changed one' } },
    { kind: 'update_note', noteId: ids.noteTwo, expectedRevision: twoRevision, patch: { body: 'changed two' } },
  ]) as { planId: string };
  transport.failPutName = `${ids.noteTwo}.md`;
  assert.equal((await client.applyChanges(plan.planId) as { status: string }).status, 'interrupted');
  assert.equal(transport.read(ids.noteOne).body, 'changed one');
  assert.equal(transport.read(ids.noteTwo).body, 'original two');
  transport.failPutName = null;
  assert.equal((await client.applyChanges(plan.planId) as { status: string }).status, 'completed');
  const putsBeforeRestore = transport.putCount;
  const restored = await client.restoreOperation(plan.planId) as { status: string };
  assert.equal(restored.status, 'completed');
  assert.equal(transport.read(ids.noteOne).body, 'original one');
  assert.equal(transport.read(ids.noteTwo).body, 'original two');
  const putsAfterRestore = transport.putCount;
  assert.equal((await client.restoreOperation(plan.planId) as { status: string }).status, 'completed');
  assert.equal(transport.putCount, putsAfterRestore);
  assert.ok(putsBeforeRestore < putsAfterRestore);
  await client.close();
}));

test('created note and notebook preserve todo metadata and multiline body', async () => withState(async stateDir => {
  const transport = new EdgeTransport(fixtureItems());
  const client = new JoplinClient(config(stateDir), transport);
  const notebookPlan = await client.previewChanges([{ kind: 'create_notebook', title: 'Projects' }]) as { planId: string; writes: { after: JoplinItem }[] };
  const notebookId = notebookPlan.writes[0]!.after.id;
  assert.equal((await client.applyChanges(notebookPlan.planId) as { status: string }).status, 'completed');
  const body = 'first line\n\nthird line\r\n🙂';
  const notePlan = await client.previewChanges([{ kind: 'create_note', notebookId, title: 'Todo', body }]) as { planId: string; writes: { after: JoplinItem }[] };
  const noteId = notePlan.writes[0]!.after.id;
  assert.equal((await client.applyChanges(notePlan.planId) as { status: string }).status, 'completed');
  const created = transport.read(noteId);
  assert.equal(created.body, body);
  assert.equal(created.properties.is_todo, '0');
  assert.equal(created.properties.todo_due, '0');
  assert.equal(created.properties.todo_completed, '0');
  assert.equal(created.properties.deleted_time, '0');
  await client.close();
}));

test('preview normalizes blank legacy numeric fields before a notebook upload', async () => withState(async stateDir => {
  const legacy = fixtureItems();
  legacy[0]!.properties.deleted_time = '';
  const transport = new EdgeTransport(legacy);
  const client = new JoplinClient(config(stateDir), transport);
  const notebooks = await client.listNotebooks() as { id: string; revision: string }[];
  const source = notebooks.find(value => value.id === ids.notebook)!;
  const plan = await client.previewChanges([{
    kind: 'rename_notebook', notebookId: source.id, expectedRevision: source.revision, title: 'Archived Inbox',
  }]) as { writes: { after: JoplinItem }[] };
  assert.equal(plan.writes[0]!.after.properties.deleted_time, '0');
  assert.equal(plan.writes[0]!.after.properties.encryption_applied, '0');
  assert.equal(plan.writes[0]!.after.properties.is_shared, '0');
  await client.close();
}));

test('note write readback accepts server-omitted schema defaults', async () => withState(async stateDir => {
  const transport = new ServerCanonicalizingTransport(fixtureItems());
  const client = new JoplinClient(config(stateDir), transport);
  const revision = (await client.getNote(ids.noteOne) as { revision: string }).revision;
  const plan = await client.previewChanges([{
    kind: 'update_note', noteId: ids.noteOne, expectedRevision: revision, patch: { title: 'Renamed' },
  }]) as { planId: string };
  const result = await client.applyChanges(plan.planId) as { status: string };
  assert.equal(result.status, 'completed');
  assert.equal(transport.read(ids.noteOne).title, 'Renamed');
  await client.close();
}));

test('moves a notebook with revision checks and rejects hierarchy cycles', async () => withState(async stateDir => {
  const transport = new EdgeTransport([
    ...fixtureItems(),
    item(ids.otherNotebook, 2, 'Work', '', { parent_id: '', deleted_time: '0' }),
    item(ids.childNotebook, 2, 'Child', '', { parent_id: ids.notebook, deleted_time: '0' }),
  ]);
  const client = new JoplinClient(config(stateDir), transport);
  const notebooks = await client.listNotebooks() as { id: string; revision: string }[];
  const source = notebooks.find(value => value.id === ids.notebook)!;
  const plan = await client.previewChanges([{
    kind: 'move_notebook', notebookId: source.id, expectedRevision: source.revision, parentId: ids.otherNotebook,
  }]) as { planId: string };
  assert.equal((await client.applyChanges(plan.planId) as { status: string }).status, 'completed');
  assert.equal(transport.read(ids.notebook).properties.parent_id, ids.otherNotebook);

  const refreshed = await client.listNotebooks() as { id: string; revision: string }[];
  const moved = refreshed.find(value => value.id === ids.notebook)!;
  await assert.rejects(
    client.previewChanges([{ kind: 'move_notebook', notebookId: moved.id, expectedRevision: moved.revision, parentId: ids.childNotebook }]),
    /cycle/,
  );
  await client.close();
}));
