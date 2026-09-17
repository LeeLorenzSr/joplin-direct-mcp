const path = require('node:path');
const fs = require('node:fs');

const sqlite3 = require('sqlite3');
const { shimInit } = require('@joplin/lib/shim-init-node');
const shim = require('@joplin/lib/shim').default;
const JoplinDatabase = require('@joplin/lib/JoplinDatabase').default;
const { DatabaseDriverNode } = require('@joplin/lib/database-driver-node');
const Setting = require('@joplin/lib/models/Setting').default;
const BaseModel = require('@joplin/lib/BaseModel').default;
const EncryptionService = require('@joplin/lib/services/e2ee/EncryptionService').default;
const RSA = require('@joplin/lib/services/e2ee/ppk/RSA.node').default;
const { setRSA, generateKeyPair } = require('@joplin/lib/services/e2ee/ppk/ppk');
const KeychainService = require('@joplin/lib/services/keychain/KeychainService').default;

// This is the minimum host application setup needed by the database and server API.
shimInit({ nodeSqlite: sqlite3, appVersion: () => 'core-feasibility-prototype' });

async function main() {
  const dbPath = path.join(__dirname, 'prototype.sqlite');
  try { fs.rmSync(dbPath, { force: true }); } catch {}
  const db = new JoplinDatabase(new DatabaseDriverNode());
  await db.open({ name: dbPath });
  BaseModel.setDb(db);
  Setting.setDb(db);
  const keychain = KeychainService.instance();
  await keychain.initialize([]);
  keychain.enabled = false;
  Setting.setKeychainService(keychain);
  await Setting.load();
  Setting.setConstant('appId', 'com.example.joplin-core-feasibility');
  Setting.setConstant('appType', 'cli');
  Setting.setConstant('env', 'prod');
  setRSA(RSA);
  EncryptionService.fsDriver_ = shim.fsDriver();
  const encryption = EncryptionService.instance();
  // The core constructor starts nonce generation asynchronously.
  await new Promise(resolve => setTimeout(resolve, 10));
  const masterKey = await encryption.generateMasterKey('test-password');
  const roundTrip = await encryption.decryptMasterKeyContent(masterKey, 'test-password');
  const ppk = await generateKeyPair(encryption, 'test-password');
  const tables = await db.selectAll("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const version = await db.selectOne('SELECT * FROM version');
  console.log(JSON.stringify({ dbPath, schemaVersion: db.version(), versionRow: version, tableCount: tables.length, tables: tables.map(t => t.name), encryption: { method: masterKey.encryption_method, contentBytes: masterKey.content.length, roundTripBytes: roundTrip.length, ppkAlgorithm: ppk.algorithm, ppkHasPublicKey: !!ppk.publicKey, ppkHasPrivateKey: !!ppk.privateKey } }, null, 2));
  await db.close();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
