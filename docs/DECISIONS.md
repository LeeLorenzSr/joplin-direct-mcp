# Implementation decisions

## 2026-09-17: direct online client for the first release

The client talks to Joplin Server over authenticated HTTP(S) itself. HTTPS is the default; explicit HTTP configuration supports self-hosted servers. Desktop, Web Clipper and a Terminal sidecar are not involved. This is the user's architectural requirement.

An executable investigation of @joplin/lib 3.7.1 successfully initialized a SQLite profile and exercised encryption primitives. It also found private deep imports, host initialization assumptions, an asynchronous encryption initialization issue, and a substantial native/transitive dependency graph. See ../research/core-feasibility/REPORT.md and prototype.cjs.

Decision: independently implement the narrowly supported plaintext, personal-library server protocol for v0.1, with source fixtures tied to upstream v3.7.18. Keep the official core experiment as evidence and a path toward an isolated E2EE adapter. Do not claim that the first release supports encrypted libraries. It fails with a specific unsupported-capability error before processing them.

## Consistency and storage

The first release is online-only and refreshes a full inventory rather than maintaining an offline sync queue. It never changes info.json or upgrades a sync target. A complete successful scan replaces the previous local snapshot atomically, but the remote scan is not a transactional server snapshot.

Opaque content revisions, dependency preconditions, per-item readback and a persistent operation journal reduce lost updates and duplicate requests. They cannot supply atomic compare-and-swap absent from the server protocol. A concurrent remote writer can still race a final GET and PUT. Multi-item changes are not transactions.

Operation intent is persisted before network mutation. Reapplying a plan reconciles remote bytes against both before- and after-images. Restoration is a compensating operation with its own durable identity. It refuses intervening edits, trashes newly created notes, retains newly created reusable tags, and refuses automatic removal of created notebooks.

The state directory is account-bound and exclusive to one client process. Normal shutdown releases ownership. After an unclean termination, an operator must verify that no process uses the profile before removing owner.lock. This conservative manual recovery avoids incorrectly stealing a live profile.

## Scope and secrets

Exact notebook ID allowlists govern tool output and operations. They do not limit the complete account inventory downloaded into the local snapshot. This first implementation is not per-notebook storage isolation. Credentials remain in environment or local config; snapshots and before-images are sensitive plaintext files.

## Verification boundary

The release includes focused service tests, protocol HTTP fixtures, and a built-process MCP stdio test. These are local executable evidence, not certification against a deployed Joplin Server. A disposable real account plus an official desktop/mobile client's round-trip is the deployment acceptance gate; no production credential or server connection was provided during implementation.
