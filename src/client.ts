import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { Change, ClientConfig, ClientOperations, JoplinItem, ServerTransport } from './contracts.js';
import { parseItem, serializeItem } from './codec.js';
import { JoplinServerTransport } from './transport.js';
import { canonicalItemProperties } from './item-defaults.js';
import { ClientError } from './errors.js';

const idSchema = z.string().regex(/^[a-f0-9]{32}$/);
const operationIdSchema = z.string().uuid();
const actionSchema = z.object({
  name: z.string().regex(/^[a-f0-9]{32}\.md$/), before: z.string().nullable(), after: z.string().nullable(),
  state: z.enum(['pending', 'done']),
});
const operationSchema = z.object({
  version: z.literal(1), id: operationIdSchema, createdAt: z.string(),
  status: z.enum(['planned', 'applying', 'completed', 'interrupted', 'restoring', 'restored']),
  changes: z.array(z.unknown()), actions: z.array(actionSchema),
  dependencies: z.record(z.string(), z.string()), restoreOf: operationIdSchema.optional(),
});
type Operation = z.infer<typeof operationSchema>;
type Action = z.infer<typeof actionSchema>;
type Snapshot = Map<string, { item: JoplinItem; raw: string }>;
const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(value);
const newId = () => randomUUID().replaceAll('-', '');
const fingerprint = (raw: string | null): string => {
  if (raw === null) return 'absent';
  const item = parseItem(raw);
  // Joplin Server may omit schema-default fields when it serializes an item
  // after PUT. Compare the logical item with those defaults restored so an
  // accepted write is not mistaken for a concurrent edit.
  const properties = [1, 2, 5, 6].includes(item.type_)
    ? canonicalItemProperties(item.type_ as 1 | 2 | 5 | 6, '', item.properties)
    : item.properties;
  return createHash('sha256').update(JSON.stringify({
    ...item,
    properties: Object.fromEntries(Object.entries(properties).sort(([a], [b]) => a.localeCompare(b))),
  })).digest('hex');
};
const cloneItem = (item: JoplinItem): JoplinItem => ({ ...item, properties: { ...item.properties } });
const timestamp = () => new Date().toISOString();
const isSet = (value: string | undefined) => value !== undefined && value !== '' && value !== '0';

/** One online account client and one journal owner per state directory. */
export class JoplinClient implements ClientOperations {
  private readonly transport: ServerTransport;
  private readonly directory: string;
  private snapshot: Snapshot = new Map();
  private lastRefresh: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private closed = false;
  private lockToken: string | null = null;

  constructor(private readonly config: ClientConfig, transport?: ServerTransport) {
    this.transport = transport ?? new JoplinServerTransport(config);
    this.directory = resolve(config.stateDir);
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.closed) throw new ClientError('invalid_state', 'Client is closed');
      await this.initialize();
      return task();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.directory, 'owner.lock');
    const token = randomUUID();
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token })); }
      finally { await handle.close(); }
      this.lockToken = token;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      // Do not steal an ambiguous/stale lock automatically: process IDs can be reused.
      throw new ClientError('invalid_state', 'State directory is locked. Stop its other client; after a crash, verify no client uses it before removing owner.lock.');
    }
    try {
      const identity = createHash('sha256').update(`${new URL(this.config.serverUrl).href}\n${this.config.email}`).digest('hex');
      const accountPath = join(this.directory, 'account.json');
      let existing: string | null = null;
      try { existing = await readFile(accountPath, 'utf8'); }
      catch (error) { if (!isMissing(error)) throw error; }
      if (existing !== null && existing !== JSON.stringify({ version: 1, identity })) throw new ClientError('invalid_state', 'This state directory belongs to a different server or account');
      if (existing === null) await this.atomicWrite(accountPath, JSON.stringify({ version: 1, identity }));
      await mkdir(join(this.directory, 'operations'), { recursive: true, mode: 0o700 });
      this.initialized = true;
    } catch (error) { await this.releaseLock(); throw error; }
  }

  private async atomicWrite(path: string, value: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, path); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockToken) return;
    const path = join(this.directory, 'owner.lock');
    const current: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof current === 'object' && current !== null && 'token' in current && current.token === this.lockToken) await unlink(path);
    this.lockToken = null;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    await this.releaseLock();
  }

  private async checkTarget(): Promise<void> {
    const raw = await this.transport.getContent('info.json');
    if (!raw) throw new ClientError('invalid_state', 'An initialized Joplin sync target with info.json is required; automatic initialization is disabled');
    const info = z.object({
      version: z.literal(3),
      e2ee: z.object({ value: z.boolean() }),
      appMinVersion: z.string().optional(),
    }).safeParse(JSON.parse(text(raw)));
    if (!info.success) throw new ClientError('invalid_state', 'Unsupported or invalid Joplin sync target configuration (v3 required)');
    if (info.data.e2ee.value) throw new ClientError('unsupported', 'E2EE is enabled. This release cannot decrypt or modify encrypted libraries.');
    if (info.data.appMinVersion) {
      const numbers = info.data.appMinVersion.split('.').map(Number);
      if (numbers.length !== 3 || numbers.some(n => !Number.isSafeInteger(n) || n < 0)
        || numbers[0]! > 3 || (numbers[0] === 3 && numbers[1]! > 7)
        || (numbers[0] === 3 && numbers[1] === 7 && numbers[2]! > 18)) {
        throw new ClientError('invalid_state', 'Sync target requires a newer Joplin format than this client supports');
      }
    }
  }

  private async refresh(): Promise<void> {
    await this.checkTarget();
    const fresh: Snapshot = new Map();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page > 10000) throw new ClientError('invalid_state', 'Inventory pagination limit exceeded');
      const result = await this.transport.listItems(cursor);
      for (const entry of result.items) {
        if (!/^[a-f0-9]{32}\.md$/.test(entry.name)) continue;
        const content = await this.transport.getContent(entry.name);
        // A concurrent deletion is consistent with an absent item in a refreshed view.
        if (content === null) continue;
        if (content.byteLength > 16 * 1024 * 1024) throw new ClientError('invalid_state', 'Note metadata item exceeds the 16 MiB client limit');
        const raw = text(content);
        const item = parseItem(raw);
        if (`${item.id}.md` !== entry.name) throw new ClientError('invalid_state', 'Server item identity does not match its filename');
        fresh.set(item.id, { item, raw });
      }
      if (!result.has_more) break;
      if (!result.cursor || cursors.has(result.cursor)) throw new ClientError('invalid_state', 'Server returned an invalid inventory cursor');
      cursors.add(result.cursor);
      cursor = result.cursor;
    }
    await this.checkTarget();
    const refreshed = timestamp();
    await this.atomicWrite(join(this.directory, 'snapshot.json'), JSON.stringify({ version: 1, refreshedAt: refreshed, items: [...fresh.values()].map(v => v.raw) }));
    this.snapshot = fresh;
    this.lastRefresh = refreshed;
  }

  private supported(item: JoplinItem): boolean {
    return !isSet(item.properties.encryption_applied) && !item.properties.encryption_cipher_text
      && !isSet(item.properties.is_locked) && !item.properties.share_id && !isSet(item.properties.is_shared)
      && !isSet(item.properties.is_conflict) && !isSet(item.properties.deleted_time)
      && (item.type_ !== 1 || !item.properties.markup_language || item.properties.markup_language === '1');
  }

  private notebookAllowed(id: string): boolean {
    const folder = this.snapshot.get(id)?.item;
    if (!folder || folder.type_ !== 2 || !this.supported(folder)) return false;
    // Parent restrictions (trash/share/lock) are inherited even with an explicit child allowlist.
    let parent = folder.properties.parent_id;
    const seen = new Set([id]);
    while (parent) {
      if (seen.has(parent)) return false;
      seen.add(parent);
      const ancestor = this.snapshot.get(parent)?.item;
      if (!ancestor || ancestor.type_ !== 2 || !this.supported(ancestor)) return false;
      parent = ancestor.properties.parent_id;
    }
    return this.config.allowedNotebookIds === null || this.config.allowedNotebookIds.includes(id);
  }

  private visible(item: JoplinItem): boolean {
    if (!this.supported(item)) return false;
    if (item.type_ === 2) return this.notebookAllowed(item.id);
    if (item.type_ === 1) return this.notebookAllowed(item.properties.parent_id ?? '');
    return false;
  }

  private requireItem(id: string, type: number): { item: JoplinItem; raw: string } {
    idSchema.parse(id);
    const record = this.snapshot.get(id);
    if (!record || record.item.type_ !== type || !this.visible(record.item)) throw new ClientError('scope', 'Item is unavailable or outside the permitted notebook scope');
    return record;
  }

  private tagsFor(noteId: string): JoplinItem[] {
    const tags: JoplinItem[] = [];
    for (const { item } of this.snapshot.values()) {
      if (item.type_ !== 6 || item.properties.note_id !== noteId || !this.supported(item)) continue;
      const tag = this.snapshot.get(item.properties.tag_id ?? '')?.item;
      if (tag?.type_ === 5 && this.supported(tag)) tags.push(tag);
    }
    return tags.sort((a, b) => a.title.localeCompare(b.title));
  }

  private noteView(record: { item: JoplinItem; raw: string }, full = false): Record<string, unknown> {
    const { item, raw } = record;
    return {
      id: item.id, title: item.title, notebookId: item.properties.parent_id,
      revision: fingerprint(raw), updatedTime: item.properties.updated_time,
      tags: this.tagsFor(item.id).map(t => ({ id: t.id, title: t.title })),
      ...(full ? { body: item.body, isTodo: item.properties.is_todo === '1', todoDue: item.properties.todo_due, todoCompleted: item.properties.todo_completed }
        : { preview: item.body.slice(0, 240) }),
    };
  }

  status(): Promise<unknown> {
    return this.run(async () => ({
      mode: 'direct-server-online', readOnly: this.config.readOnly, lastSuccessfulRefresh: this.lastRefresh,
      scope: this.config.allowedNotebookIds === null ? 'whole-account' : 'explicit-notebooks',
      supported: ['plaintext-personal-markdown', 'sync-format-3'], encryptionSupported: false,
      consistency: 'Online snapshots and precondition checks; no server-side atomic compare-and-swap',
    }));
  }

  sync(): Promise<unknown> {
    return this.run(async () => {
      await this.refresh();
      return { refreshedAt: this.lastRefresh, visibleNotes: [...this.snapshot.values()].filter(v => v.item.type_ === 1 && this.visible(v.item)).length };
    });
  }

  listNotebooks(): Promise<unknown> {
    return this.run(async () => {
      await this.refresh();
      return [...this.snapshot.values()].filter(v => v.item.type_ === 2 && this.visible(v.item)).map(({ item, raw }) => ({
        id: item.id, title: item.title, parentId: item.properties.parent_id || null, revision: fingerprint(raw),
      }));
    });
  }

  listTags(): Promise<unknown> {
    return this.run(async () => {
      await this.refresh();
      const visibleTags = new Map<string, JoplinItem>();
      for (const { item } of this.snapshot.values()) if (item.type_ === 1 && this.visible(item)) {
        for (const tag of this.tagsFor(item.id)) visibleTags.set(tag.id, tag);
      }
      return [...visibleTags.values()].map(t => ({ id: t.id, title: t.title }));
    });
  }

  searchNotes(args: { query: string; notebookId?: string; offset?: number; limit?: number }): Promise<unknown> {
    return this.run(async () => {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 25;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ClientError('invalid_state', 'Invalid pagination; limit must be 1..100');
      await this.refresh();
      if (args.notebookId) this.requireItem(args.notebookId, 2);
      const query = args.query.toLocaleLowerCase();
      const matches = [...this.snapshot.values()].filter(({ item }) => item.type_ === 1 && this.visible(item)
        && (!args.notebookId || item.properties.parent_id === args.notebookId)
        && `${item.title}\n${item.body}`.toLocaleLowerCase().includes(query)).sort((a, b) => a.item.id.localeCompare(b.item.id));
      return { items: matches.slice(offset, offset + limit).map(v => this.noteView(v)), total: matches.length, hasMore: offset + limit < matches.length, refreshedAt: this.lastRefresh };
    });
  }

  getNote(id: string): Promise<unknown> {
    return this.run(async () => { await this.refresh(); return this.noteView(this.requireItem(id, 1), true); });
  }

  getResource(args: { noteId: string; resourceId: string }): Promise<unknown> {
    return this.run(async () => {
      idSchema.parse(args.resourceId);
      await this.refresh();
      const { item: note } = this.requireItem(args.noteId, 1);
      if (!new RegExp(`:/` + args.resourceId + `(?![a-f0-9])`).test(note.body)) throw new ClientError('invalid_state', 'Resource must be linked from the permitted note');
      const resource = this.snapshot.get(args.resourceId)?.item;
      if (!resource || resource.type_ !== 4 || !this.supported(resource) || isSet(resource.properties.encryption_blob_encrypted)) throw new ClientError('invalid_state', 'Resource is unavailable or encrypted');
      const content = await this.transport.getContent(`.resource/${args.resourceId}`);
      if (!content) throw new ClientError('invalid_state', 'Resource binary is unavailable');
      if (content.byteLength > 2 * 1024 * 1024) throw new ClientError('invalid_state', 'Resource exceeds the 2 MiB inline retrieval limit');
      return { id: resource.id, title: resource.title, mime: resource.properties.mime || 'application/octet-stream', encoding: 'base64', data: Buffer.from(content).toString('base64') };
    });
  }

  private ensureWrite(): void { if (this.config.readOnly) throw new ClientError('read_only', 'Writes are disabled by configuration'); }
  private operationPath(id: string): string { operationIdSchema.parse(id); return join(this.directory, 'operations', `${id}.json`); }
  private saveOperation(operation: Operation): Promise<void> { return this.atomicWrite(this.operationPath(operation.id), JSON.stringify(operation, null, 2)); }
  private async loadOperation(id: string): Promise<Operation> { return operationSchema.parse(JSON.parse(await readFile(this.operationPath(id), 'utf8'))); }

  private newItem(type: number, title: string, body: string, properties: Record<string, string> = {}): JoplinItem {
    const now = timestamp();
    const id = newId();
    if (![1, 2, 5, 6].includes(type)) throw new ClientError('invalid_state', `Unsupported new item type: ${type}`);
    return { id, type_: type, title, body, properties: canonicalItemProperties(type as 1 | 2 | 5 | 6, now, properties) };
  }

  previewChanges(changes: Change[]): Promise<unknown> {
    return this.run(async () => {
      if (changes.length < 1 || changes.length > 100) throw new ClientError('invalid_state', 'A plan must contain 1..100 changes');
      await this.refresh();
      const operation: Operation = { version: 1, id: randomUUID(), createdAt: timestamp(), status: 'planned', changes, actions: [], dependencies: {} };
      const touched = new Set<string>();
      const add = (before: string | null, after: JoplinItem | null, id: string) => {
        if (touched.has(id)) throw new ClientError('invalid_state', 'Use one change per item in a plan');
        touched.add(id);
        if (after && [1, 2, 5, 6].includes(after.type_)) {
          after.properties = canonicalItemProperties(
            after.type_ as 1 | 2 | 5 | 6,
            after.properties.created_time || timestamp(),
            after.properties,
          );
        }
        operation.actions.push({ name: `${id}.md`, before, after: after ? serializeItem(after) : null, state: 'pending' });
      };
      const depend = (id: string, type: number) => {
        const record = this.requireItem(id, type);
        operation.dependencies[`${id}.md`] = fingerprint(record.raw);
        return record;
      };
      const noteChanges = new Set<string>();
      const plannedTags = new Map<string, JoplinItem>();
      for (const change of changes) {
        if ('noteId' in change) {
          if (noteChanges.has(change.noteId)) throw new ClientError('invalid_state', 'Use one change per note in a plan');
          noteChanges.add(change.noteId);
        }
        if (change.kind === 'create_note') {
          depend(change.notebookId, 2);
          const item = this.newItem(1, change.title, change.body, { parent_id: change.notebookId, is_todo: '0', todo_due: '0', todo_completed: '0', markup_language: '1', deleted_time: '0', is_conflict: '0' });
          add(null, item, item.id);
        } else if (change.kind === 'create_notebook') {
          if (this.config.allowedNotebookIds !== null) throw new ClientError('invalid_state', 'Creating notebooks requires whole-account scope; new IDs cannot silently expand an allowlist');
          if (change.parentId) depend(change.parentId, 2);
          const item = this.newItem(2, change.title, '', { parent_id: change.parentId ?? '', deleted_time: '0' });
          add(null, item, item.id);
        } else if (change.kind === 'rename_notebook' || change.kind === 'move_notebook') {
          const record = depend(change.notebookId, 2);
          if (fingerprint(record.raw) !== change.expectedRevision) throw new ClientError('stale_revision', 'Notebook changed since it was read');
          const item = cloneItem(record.item);
          if (change.kind === 'rename_notebook') item.title = change.title;
          else {
            if (this.config.allowedNotebookIds !== null) throw new ClientError('invalid_state', 'Moving notebooks requires whole-account scope');
            if (change.parentId === item.id) throw new ClientError('invalid_state', 'A notebook cannot be its own parent');
            depend(change.parentId, 2);
            let ancestorId: string | undefined = change.parentId;
            const ancestors = new Set<string>();
            while (ancestorId) {
              if (ancestorId === item.id) throw new ClientError('invalid_state', 'Moving this notebook would create a cycle');
              if (ancestors.has(ancestorId)) throw new ClientError('invalid_state', 'Destination notebook ancestry contains a cycle');
              ancestors.add(ancestorId);
              ancestorId = this.snapshot.get(ancestorId)?.item.properties.parent_id;
            }
            item.properties.parent_id = change.parentId;
          }
          item.properties.updated_time = timestamp();
          add(record.raw, item, item.id);
        } else {
          const record = depend(change.noteId, 1);
          if (fingerprint(record.raw) !== change.expectedRevision) throw new ClientError('stale_revision', 'Note changed since it was read');
          if (change.kind === 'tag_note') {
            const title = change.tagTitle.trim();
            if (!title || /[\r\n]/.test(title)) throw new ClientError('invalid_state', 'Tag title must be a nonempty single line');
            const candidates = [...this.snapshot.values()].filter(v => v.item.type_ === 5 && v.item.title.toLocaleLowerCase() === title.toLocaleLowerCase());
            if (candidates.length > 1) throw new ClientError('invalid_state', 'Ambiguous duplicate tag titles');
            let tag = candidates[0]?.item ?? plannedTags.get(title.toLocaleLowerCase());
            if (tag && !this.supported(tag)) throw new ClientError('invalid_state', 'Tag is encrypted, shared, or locked');
            if (tag && this.snapshot.has(tag.id)) operation.dependencies[`${tag.id}.md`] = fingerprint(this.snapshot.get(tag.id)!.raw);
            if (!tag && !change.remove) {
              tag = this.newItem(5, title, ''); add(null, tag, tag.id);
              plannedTags.set(title.toLocaleLowerCase(), tag);
            }
            if (tag) {
              const links = [...this.snapshot.values()].filter(v => v.item.type_ === 6 && v.item.properties.note_id === change.noteId && v.item.properties.tag_id === tag.id);
              if (links.some(v => !this.supported(v.item))) throw new ClientError('invalid_state', 'Tag relationship is not editable');
              if (change.remove) for (const link of links) add(link.raw, null, link.item.id);
              else if (!links.length) {
                const link = this.newItem(6, '', '', { note_id: change.noteId, tag_id: tag.id }); add(null, link, link.id);
              }
            }
          } else {
            const item = cloneItem(record.item);
            if (change.kind === 'trash_note') item.properties.deleted_time = String(Date.now());
            else {
              const patch = change.patch;
              if (patch.parent_id !== undefined) depend(patch.parent_id, 2);
              if (patch.title !== undefined) item.title = patch.title;
              if (patch.body !== undefined) item.body = patch.body;
              for (const key of ['parent_id', 'is_todo', 'todo_due', 'todo_completed'] as const) {
                if (patch[key] !== undefined) item.properties[key] = String(patch[key]);
              }
            }
            item.properties.updated_time = timestamp(); item.properties.user_updated_time = item.properties.updated_time;
            add(record.raw, item, item.id);
          }
        }
      }
      await this.saveOperation(operation);
      return { planId: operation.id, changes, writes: operation.actions.map(a => ({ itemId: a.name.slice(0, -3), action: a.before === null ? 'create' : a.after === null ? 'remove-tag-link' : 'update', before: a.before === null ? null : parseItem(a.before), after: a.after === null ? null : parseItem(a.after) })), readOnly: this.config.readOnly, atomic: false };
    });
  }

  private rawFromSnapshot(name: string): string | null { return this.snapshot.get(name.slice(0, -3))?.raw ?? null; }

  private checkOperationScope(operation: Operation): void {
    const created = new Map(operation.actions.filter(a => a.after !== null).map(a => { const item = parseItem(a.after!); return [item.id, item] as const; }));
    for (const action of operation.actions) {
      for (const raw of [action.before, action.after]) {
        if (raw === null) continue;
        const item = parseItem(raw);
        if (`${item.id}.md` !== action.name) throw new ClientError('invalid_state', 'Journal item identity mismatch');
        const allowed = cloneItem(item); allowed.properties.deleted_time = '0';
        if (!this.supported(allowed)) throw new ClientError('invalid_state', 'Operation contains an unsupported item');
        if (item.type_ === 1 && !this.notebookAllowed(item.properties.parent_id ?? '')) throw new ClientError('invalid_state', 'Operation note is outside permitted scope');
        if (item.type_ === 2 && this.config.allowedNotebookIds !== null && !this.notebookAllowed(item.id)) throw new ClientError('invalid_state', 'Operation notebook is outside permitted scope');
        if (item.type_ === 6) {
          const note = this.snapshot.get(item.properties.note_id ?? '')?.item;
          if (!note || !this.visible(note)) throw new ClientError('invalid_state', 'Tag operation is outside permitted scope');
        }
        if (item.type_ === 5) {
          const used = [...created.values()].some(link => link.type_ === 6 && link.properties.tag_id === item.id);
          if (!used) throw new ClientError('invalid_state', 'Standalone tag mutation is unsupported');
        }
        if (![1, 2, 5, 6].includes(item.type_)) throw new ClientError('invalid_state', 'Unsupported journal item type');
      }
    }
  }

  private async apply(operation: Operation): Promise<unknown> {
    this.ensureWrite();
    await this.refresh();
    this.checkOperationScope(operation);
    if (operation.status === 'completed' || operation.status === 'restored') return this.operationSummary(operation);
    if (operation.status === 'restoring') throw new ClientError('invalid_state', 'This operation is being restored; resume restore_operation instead');
    for (const action of operation.actions) {
      if (action.before !== null || action.after === null) continue;
      const proposed = parseItem(action.after);
      for (const { item } of this.snapshot.values()) {
        if (item.id === proposed.id) continue;
        if (proposed.type_ === 5 && item.type_ === 5 && item.title.toLocaleLowerCase() === proposed.title.toLocaleLowerCase()) {
          throw new ClientError('conflict', 'A matching tag was created after preview; prepare a new plan');
        }
        if (proposed.type_ === 6 && item.type_ === 6 && item.properties.note_id === proposed.properties.note_id && item.properties.tag_id === proposed.properties.tag_id) {
          throw new ClientError('conflict', 'This tag relationship was added after preview; prepare a new plan');
        }
      }
    }
    // Reconcile every action before any further write. A prior process may have stopped after PUT.
    for (const action of operation.actions) {
      const current = this.rawFromSnapshot(action.name);
      if (fingerprint(current) === fingerprint(action.after)) action.state = 'done';
      else if (action.state === 'done' || fingerprint(current) !== fingerprint(action.before)) throw new ClientError('invalid_state', 'Operation conflicts with a newer server change; no remaining changes were applied');
    }
    for (const [name, expected] of Object.entries(operation.dependencies)) {
      if (operation.actions.some(a => a.name === name && a.state === 'done')) continue;
      if (fingerprint(this.rawFromSnapshot(name)) !== expected) throw new ClientError('invalid_state', 'A plan dependency changed; create a new preview');
    }
    operation.status = 'applying'; await this.saveOperation(operation);
    try {
      for (const action of operation.actions) {
        if (action.state === 'done') continue;
        await this.checkTarget();
        for (const [name, expected] of Object.entries(operation.dependencies)) {
          const done = operation.actions.find(a => a.name === name && a.state === 'done');
          const dependency = await this.transport.getContent(name);
          if (fingerprint(dependency === null ? null : text(dependency)) !== (done ? fingerprint(done.after) : expected)) {
            throw new ClientError('conflict', 'A plan dependency changed immediately before write');
          }
        }
        const currentBytes = await this.transport.getContent(action.name);
        const current = currentBytes === null ? null : text(currentBytes);
        if (fingerprint(current) !== fingerprint(action.before)) throw new ClientError('invalid_state', 'Item changed immediately before write');
        if (action.after === null) await this.transport.deleteItem(action.name);
        else await this.transport.putContent(action.name, bytes(action.after));
        const verified = await this.transport.getContent(action.name);
        if (fingerprint(verified === null ? null : text(verified)) !== fingerprint(action.after)) throw new ClientError('invalid_state', 'Write readback differs; outcome requires reconciliation');
        action.state = 'done'; await this.saveOperation(operation);
      }
      operation.status = 'completed'; await this.saveOperation(operation);
      await this.refresh();
      return this.operationSummary(operation);
    } catch (error) {
      operation.status = 'interrupted'; await this.saveOperation(operation);
      return { ...this.operationSummary(operation), error: 'Operation interrupted. Some writes may have reached the server. Apply the same plan ID to reconcile; do not create a duplicate plan.',
        ...(error instanceof ClientError ? { reason: error.message, code: error.code } : {}) };
    }
  }

  private operationSummary(operation: Operation): Record<string, unknown> {
    return { operationId: operation.id, status: operation.status, createdAt: operation.createdAt, atomic: false,
      results: operation.actions.map(a => ({ itemId: a.name.slice(0, -3), state: a.state })),
      ...(operation.restoreOf ? { restoreOf: operation.restoreOf } : {}) };
  }

  applyChanges(planId: string): Promise<unknown> { return this.run(async () => this.apply(await this.loadOperation(planId))); }

  getOperation(operationId: string): Promise<unknown> {
    return this.run(async () => {
      const operation = await this.loadOperation(operationId);
      await this.refresh(); this.checkOperationScope(operation);
      return this.operationSummary(operation);
    });
  }

  restoreOperation(operationId: string): Promise<unknown> {
    return this.run(async () => {
      this.ensureWrite();
      const original = await this.loadOperation(operationId);
      await this.refresh(); this.checkOperationScope(original);
      if (original.status === 'planned') throw new ClientError('invalid_state', 'This operation has not been applied');
      // Deterministic restoration ID makes repeated requests resume the same restoration.
      const hex = createHash('sha256').update(`restore:${original.id}`).digest('hex').slice(0, 32);
      const restoreId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
      let restoration: Operation | undefined;
      try { restoration = await this.loadOperation(restoreId); }
      catch (error) { if (!isMissing(error)) throw error; }
      if (!restoration) {
        restoration = { version: 1, id: restoreId, createdAt: timestamp(), status: 'planned', changes: [], actions: [], dependencies: {}, restoreOf: original.id };
        for (const action of [...original.actions].reverse()) {
          const current = fingerprint(this.rawFromSnapshot(action.name));
          if (action.state === 'pending' && current === fingerprint(action.before)) continue;
          if (current !== fingerprint(action.after)) throw new ClientError('conflict', 'Cannot restore: an item changed after the operation');
          const after = action.after === null ? null : parseItem(action.after);
          if (action.before === null && after?.type_ === 5) continue; // Leave newly created reusable tags intact.
          if (action.before === null && after?.type_ === 2) throw new ClientError('invalid_state', 'Created notebooks require manual removal; automatic restoration cannot safely remove their descendants');
          let restored: string | null = action.before;
          if (action.before === null && after?.type_ === 1) {
            after.properties.deleted_time = String(Date.now()); after.properties.updated_time = timestamp(); restored = serializeItem(after);
          } else if (restored !== null) {
            const item = parseItem(restored); item.properties.updated_time = timestamp(); restored = serializeItem(item);
          }
          restoration.actions.push({ name: action.name, before: action.after, after: restored, state: 'pending' });
        }
        await this.saveOperation(restoration);
      }
      original.status = 'restoring'; await this.saveOperation(original);
      const result = await this.apply(restoration);
      if (restoration.status === 'completed') { original.status = 'restored'; await this.saveOperation(original); }
      return result;
    });
  }
}

function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
