const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { shimInit } = require('@joplin/lib/shim-init-node');
const shim = require('@joplin/lib/shim').default;
const JoplinDatabase = require('@joplin/lib/JoplinDatabase').default;
const { DatabaseDriverNode } = require('@joplin/lib/database-driver-node');
const BaseModel = require('@joplin/lib/BaseModel').default;
const BaseItem = require('@joplin/lib/models/BaseItem').default;
const Setting = require('@joplin/lib/models/Setting').default;
const KeychainService = require('@joplin/lib/services/keychain/KeychainService').default;
const Note = require('@joplin/lib/models/Note').default;
const Folder = require('@joplin/lib/models/Folder').default;
const Resource = require('@joplin/lib/models/Resource').default;
const Tag = require('@joplin/lib/models/Tag').default;
const NoteTag = require('@joplin/lib/models/NoteTag').default;
const MasterKey = require('@joplin/lib/models/MasterKey').default;
const Revision = require('@joplin/lib/models/Revision').default;
const { parseItem, serializeItem } = require('../../src/codec.ts');
const { canonicalItemProperties } = require('../../src/item-defaults.ts');

shimInit({ nodeSqlite: sqlite3, appVersion: () => 'codec-proof' });

async function main() {
  const dbPath = path.join(__dirname, 'codec-proof.sqlite');
  fs.rmSync(dbPath, { force: true });
  const db = new JoplinDatabase(new DatabaseDriverNode());
  await db.open({ name: dbPath });
  BaseModel.setDb(db);
  Setting.setDb(db);
  const keychain = KeychainService.instance();
  await keychain.initialize([]);
  keychain.enabled = false;
  Setting.setKeychainService(keychain);
  await Setting.load();
  for (const [name, value] of [['appId', 'codec-proof'], ['appType', 'cli'], ['env', 'prod']]) Setting.setConstant(name, value);
  for (const [name, klass] of Object.entries({ Note, Folder, Resource, Tag, NoteTag, MasterKey, Revision })) BaseItem.loadClass(name, klass);

  const note = {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', type_: 1, title: 'Todo title', body: 'line 1\n\nline 3',
    parent_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', created_time: 1700000000000, updated_time: 1700000001000,
    user_created_time: 1700000000000, user_updated_time: 1700000001000,
    todo_due: 1700000002000, todo_completed: 1700000003000, is_todo: 1, deleted_time: 0,
    is_conflict: 0, encryption_applied: 0, encryption_cipher_text: '', unknown_future_property: 'preserve-me',
  };
  const coreWire = await BaseItem.serializeForSync(note);
  const coreRead = await BaseItem.unserialize(coreWire);
  const ours = parseItem(coreWire);
  const ownWire = serializeItem({ id: note.id, type_: 1, title: note.title, body: note.body, properties: {
    parent_id: note.parent_id, created_time: '2023-11-14T22:13:20.000Z', updated_time: '2023-11-14T22:13:21.000Z',
    user_created_time: '2023-11-14T22:13:20.000Z', user_updated_time: '2023-11-14T22:13:21.000Z',
    todo_due: '1700000002000', todo_completed: '1700000003000', is_todo: '1', deleted_time: '0',
    encryption_applied: '0', unknown_future_property: 'preserve-me',
  } });
  const ownRead = await BaseItem.unserialize(ownWire);
  const minimalByType = {
    1: { id: note.id, type_: 1, title: 'Todo title', body: '', parent_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    2: { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', type_: 2, title: 'Folder', parent_id: '' },
    5: { id: 'cccccccccccccccccccccccccccccccc', type_: 5, title: 'Tag' },
    6: { id: 'dddddddddddddddddddddddddddddddd', type_: 6, note_id: note.id, tag_id: 'cccccccccccccccccccccccccccccccc' },
  };
  const canonical = {};
  for (const [type, value] of Object.entries(minimalByType)) {
    const ModelClass = BaseItem.itemClass(Number(type));
    const raw = await ModelClass.serialize(value);
    const parsed = await BaseItem.unserialize(raw);
    const canonicalRaw = await ModelClass.serialize(parsed);
    canonical[type] = { raw, canonicalRaw, parsedProperties: Object.fromEntries(Object.entries(parsed).filter(([key]) => !['id', 'type_', 'title', 'body'].includes(key))) };
  }
  const coreType6Wire = canonical['6'].canonicalRaw;
  const createRoundTrips = [];
  for (const [type, value] of Object.entries(minimalByType)) {
    const overrides = Object.fromEntries(Object.entries(value).filter(([key]) => !['id', 'type_', 'title', 'body'].includes(key)));
    if (Number(type) === 1) overrides.markup_language = '1';
    const original = { id: value.id, type_: Number(type), title: value.title || '', body: value.body || '', properties: canonicalItemProperties(Number(type), '2023-11-14T22:13:20.000Z', overrides) };
    const ModelClass = BaseItem.itemClass(Number(type));
    const serverWire = await ModelClass.serialize(await BaseItem.unserialize(serializeItem(original)));
    assert.deepEqual(parseItem(serverWire), original, `Type ${type} must survive the official server parse/serialize cycle`);
    createRoundTrips.push({ type: Number(type), exactPropertiesPreserved: true });
  }
  const output = {
    schemaVersion: db.version(),
    coreSerializeParsedByOwnCodec: { type: ours.type_, title: ours.title, body: ours.body, todoDue: ours.properties.todo_due, deletedTime: ours.properties.deleted_time },
    coreUnserialize: { type: coreRead.type_, title: coreRead.title, body: coreRead.body, todo_due: coreRead.todo_due, todo_completed: coreRead.todo_completed, unknownDropped: !('unknown_future_property' in coreRead) },
    ownSerializeParsedByCore: { type: ownRead.type_, title: ownRead.title, body: ownRead.body, todo_due: ownRead.todo_due, todo_completed: ownRead.todo_completed, unknownDropped: !('unknown_future_property' in ownRead) },
    ownCodecUnknownPreserved: parseItem(ownWire).properties.unknown_future_property,
    ownCodecParsesOfficialMetadataOnlyType6: parseItem(coreType6Wire).type_ === 6,
    createRoundTrips,
    canonical,
  };
  fs.writeFileSync(path.join(__dirname, 'codec-proof-output.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output));
  await db.close();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
