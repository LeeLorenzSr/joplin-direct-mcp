# Joplin core embedding feasibility

- Date: 2026-09-17
- Environment: Node v22.17.0, Windows x64
- Package tested: `@joplin/lib@3.7.1` (npm tarball gitHead `c17c205049ce74e449dc1ce08cbd1c875410d7d5`)
- License: `AGPL-3.0-or-later`

## Decision

Embedding the official core is technically feasible for a headless SQLite store and for E2EE primitives. It is not a small, stable SDK: the package has no `main` or `exports` entry (so `require('@joplin/lib')` fails) and requires deep imports plus platform dependency injection through `shimInit`. The package brings a large dependency graph (564 packages in this proof, including UI and optional AI/media dependencies) even when only database and crypto are used.

Use the direct-server protocol implementation for the P1 plaintext MCP client. Keep core embedding as a separately gated P3 crypto experiment, or vendor/pin a small adapter around the deep imports. Embedding `Synchronizer` itself is possible in principle but is coupled to application globals, settings, Redux dispatch, registries, resource workers and startup migrations; it does not provide a single headless `sync()` entry point.

## Executable evidence

[`prototype.cjs`](./prototype.cjs) performs the minimum host setup and proves:

1. `JoplinDatabase.open({ name })` creates and upgrades a real SQLite database to schema version 53 (34 tables, including `notes`, `folders`, `master_keys`, `sync_items`, FTS tables and `version`).
2. `EncryptionService` creates and decrypts a `KeyV1` master key (method 8) using Node WebCrypto.
3. The Node RSA provider generates a PPK (default `rsa-v3`) without Electron or a desktop process.

Observed output from `node prototype.cjs`:

```json
{"schemaVersion":53,"tableCount":34,"encryption":{"method":8,"contentBytes":451,"roundTripBytes":512,"ppkHasPublicKey":true,"ppkHasPrivateKey":true}}
```

[`codec-proof.cjs`](./codec-proof.cjs) additionally registers the official
`Note`, `Folder`, `Tag`, `NoteTag`, `MasterKey` and `Revision` classes and
round-trips generated items through `BaseItem.serialize`/`unserialize`. Its
stdout is saved in `codec-proof-output.json`. This confirms that `todo_due`
and `todo_completed` are integer millisecond strings on the wire, while
`created_time`, `updated_time`, `user_created_time` and `user_updated_time`
are ISO date strings. It also confirms that type 6 (`NoteTag`) is
metadata-only: its official serialization starts with `id:` and has no title
or body section.

For the schema-v53 create templates, omitted fields are filled by core as
follows (empty values are significant because the server reserializes every
known field):

```text
Note:    is_conflict=0 latitude=0.00000000 longitude=0.00000000 altitude=0.0000
         is_todo=0 todo_due=0 todo_completed=0 order=0 encryption_applied=0
         markup_language=0 is_shared=0 deleted_time=0 is_locked=0
Folder:  encryption_applied=0 is_shared=0 deleted_time=0
Tag:     encryption_applied=0 is_shared=0
NoteTag: encryption_applied=0 is_shared=0
```

The remaining known fields are emitted with an empty string and should be
present when exact byte/fingerprint readback is required. The production
adapter helper [`src/item-defaults.ts`](../../src/item-defaults.ts) contains
these per-type defaults and timestamp handling, generated from this proof.

The probe also asserts that records created with the production defaults for
types 1, 2, 5 and 6 survive the official parse/serialize cycle with every
property unchanged. All four assertions passed. Run this additional probe
from the project root with `npx tsx research/core-feasibility/codec-proof.cjs`
after installing the isolated research dependencies.

The first version intentionally called crypto immediately after `EncryptionService.instance()`. That failed because the constructor starts nonce generation asynchronously and has no public readiness method. The prototype waits 10 ms before encrypting; a production adapter must explicitly yield until that initialization completes (or add a narrowly scoped readiness wrapper).

## Minimal initialization surface

The following CommonJS imports resolve from the npm package; the package root does not:

```js
const sqlite3 = require('sqlite3');
const { shimInit } = require('@joplin/lib/shim-init-node');
const shim = require('@joplin/lib/shim').default;
const JoplinDatabase = require('@joplin/lib/JoplinDatabase').default;
const { DatabaseDriverNode } = require('@joplin/lib/database-driver-node');
const BaseModel = require('@joplin/lib/BaseModel').default;
const Setting = require('@joplin/lib/models/Setting').default;
const KeychainService = require('@joplin/lib/services/keychain/KeychainService').default;
const EncryptionService = require('@joplin/lib/services/e2ee/EncryptionService').default;
const RSA = require('@joplin/lib/services/e2ee/ppk/RSA.node').default;
const { setRSA, generateKeyPair } = require('@joplin/lib/services/e2ee/ppk/ppk');

shimInit({ nodeSqlite: sqlite3, appVersion: () => 'headless-client' });
const db = new JoplinDatabase(new DatabaseDriverNode());
await db.open({ name: dbPath });
BaseModel.setDb(db);
Setting.setDb(db);
const keychain = KeychainService.instance();
await keychain.initialize([]);       // no OS keychain in a headless profile
keychain.enabled = false;
Setting.setKeychainService(keychain);
await Setting.load();
Setting.setConstant('appId', 'org.example.headless-client');
Setting.setConstant('appType', 'cli');
Setting.setConstant('env', 'prod');
setRSA(RSA);
EncryptionService.fsDriver_ = shim.fsDriver();
const crypto = EncryptionService.instance();
```

The official `BaseApplication.start()` follows the same pieces but additionally creates a profile, initializes the keychain/settings migration, sets every global constant, registers all sync targets, starts resource/decryption/search workers, creates Redux and dispatchers, and runs migrations. That path is application startup, not a lightweight library bootstrap.

## Native and runtime dependencies

- `sqlite3@5.1.6` is a native N-API dependency. The proof loaded `lib/binding/napi-v6-win32-unknown-x64/node_sqlite3.node` successfully on Node 22.17.0. Packaging must provide a compatible binary for every supported OS/architecture and Node ABI.
- Node built-in WebCrypto is sufficient for the current `KeyV1`, `FileV1` and `StringV1` AES-GCM/PBKDF2 implementation. RSA PPK support is provided by the package's Node RSA provider and WebCrypto providers.
- `sqlite-vec` is optional and can be passed as `null`; `JoplinDatabase` logs that vector search is disabled and still opens successfully.
- A keychain driver is optional for a dedicated profile, but `Setting.load()` still requires an initialized `KeychainService`. Initializing it with no drivers and disabling it works for explicit password handling.
- The published package pulls many non-headless dependencies (renderer, React-related code, AWS/S3, PDF, image, OCR and others). This is a maintenance and install-size cost even though no desktop/Web Clipper process is used.

## Sync and E2EE boundaries

`JoplinServerApi` is reusable through a deep import. It authenticates with `POST api/sessions`, sends the returned session ID as `X-API-AUTH`, and always sends `X-API-MIN-VERSION: 2.6.0`. `SyncTargetJoplinServer` builds a `FileApiDriverJoplinServer`; its wire paths are `api/items/root:/<path>:` with `/content`, `/children`, `/delta`, and batch writes at `api/batch_items`.

Those classes are not a complete standalone sync client. `Synchronizer` consumes a configured `JoplinDatabase`, `FileApi`, `Setting` globals, sync-info/master-key state, dispatch callbacks and application services. Reusing it would couple the MCP process to private internals and upstream schema/startup changes. The protocol client should continue to own inventory, snapshot atomicity, scope and write journaling.

Core E2EE can be reused only after the client has the full E2EE sync state. A password alone is not enough: encrypted item payloads refer to a master-key ID; the master key is itself encrypted; and the PPK/master-key chain and `activeMasterKeyId` live in sync info. `BaseItem.serializeForSync` also applies Joplin's encrypted-item header/chunk representation and preserves only selected cleartext linkage/timestamp fields. Correct P3 support therefore needs compatibility fixtures from an official client, version/capability gates, and explicit handling of encrypted, locked and shared items. It must never silently parse an encrypted item as a plaintext note.

## Direct protocol comparison

The direct implementation has a smaller and more reviewable runtime: HTTPS/session authentication, the sync item serializer, complete snapshot enumeration and explicit unsupported-item gates. It avoids native SQLite, Redux, keychain setup and private core globals. The tradeoff is that E2EE serialization/decryption must be added deliberately (or through the isolated core crypto adapter) and sync optimizations such as delta must be implemented separately. That tradeoff matches the spec's P1 plaintext scope and keeps P3 encryption behind a real compatibility proof.

## Reproduction

From this directory:

```text
npm install @joplin/lib@3.7.1 sqlite3@5.1.6 --no-audit --no-fund
node prototype.cjs
```

No desktop app, Web Clipper, server database access or credentials were used. The proof is local SQLite/crypto only; it is not a certification against a live Joplin Server.
