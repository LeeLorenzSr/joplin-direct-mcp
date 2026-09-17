# Joplin Direct MCP Client — implementation specification

Status: v0.1 implemented with local verification, 2026-09-17; live-server acceptance pending. User direction: a purpose-built client talking directly to Joplin Server using configured credentials. No dependency on Desktop, Web Clipper, browser automation, or a Terminal sidecar.

## Outcome and caller experience

An agent can discover notebooks, search and read notes, retrieve linked attachments, and prepare/apply auditable edits, moves, tags and notebook changes. A Codex plugin supplies the connection and personal workflow skills. Existing desktop/mobile clients receive these changes through their normal synchronization.

Example: search_notes({query:'router'}) returns bounded matches with IDs and revisions; get_note returns full content; preview_changes produces an exact persisted change plan; apply_changes(planId) rechecks source revisions, writes, reads back, and returns per-change results and operation ID. Repeating apply on the same plan reconciles the existing operation, never creates a second copy. No claim of global atomicity or guaranteed conflict-free concurrent editing.

## Architecture and ownership

- Transport owns HTTP(S), credential authentication through /api/sessions, X-API-AUTH sessions, request deadlines, server errors and wire response validation. No credentials or full upstream error bodies in logs/tools.
- Codec owns serialized Joplin item parsing and writing, preserving unmodified/unknown metadata and body content. Authoritative protocol reference is a pinned upstream source version.
- Client owns a local snapshot, access policy, online refresh, note relationships, revision checks, exact change plans and crash journal. One process owns each state directory; concurrent requests serialize through the client. Server data is authoritative. No offline outgoing queue in v0.1.
- MCP owns schemas, tool descriptions, pagination and safe error envelopes. stdio only in v0.1. stdout is reserved for protocol messages.
- Codex plugin packages configuration, skills and setup/diagnostic documentation. Configuration and secrets remain outside the distributable plugin.

Authoritative TypeScript contracts: src/contracts.ts. The wire item has title/body plus a string-valued metadata dictionary; the domain exposes only ordinary notes/notebooks/tags/resources. Encrypted, shared, locked or unsupported representations must not be silently interpreted or modified.

## Implementation decisions

The isolated @joplin/lib experiment established that core initialization is possible, but requires private imports, host setup and native dependencies. The implemented v0.1 uses a narrowly supported online protocol client, with official-core serialization checks and explicit unsupported-capability gates. See [decisions](DECISIONS.md) and [executable core investigation](../research/core-feasibility/REPORT.md). E2EE remains a separate adapter project rather than an implied consequence of server authentication.

Initial online snapshot uses paginated root children enumeration and exact item content downloads. Refresh builds a complete new snapshot and atomically replaces the old one only after success. A failed refresh cannot make an incomplete library appear authoritative. Delta sync is an optimization for a later release, with full rebuild on expired cursor; never necessary for first-release correctness.

Before writes, refresh sync info and relevant account snapshot; reject unsupported target versions, enabled E2EE without a working tested crypto adapter, encrypted items, locked items, and shared items. A missing info.json is not permission to initialize or upgrade a target. The client must never modify sync configuration/master keys automatically.

## Scope and phases

P0: executable transport/core feasibility proof and source-grounded protocol fixtures.

P1: direct-server plaintext personal-library MVP: authenticated connection, paginated inventory, notebooks/tags, literal title/body search (explicitly not Joplin search syntax), full note retrieval, bounded linked-resource retrieval, create/update/move/trash notes, create/rename/reparent notebooks, apply/remove tags. Notebook reparenting is revision checked, rejects cycles, and requires whole-account scope. Tool results return stable IDs and opaque revision hashes. Reads obey notebook allowlist. Newly created notebooks must not expand a configured allowlist implicitly.

P2: durable plan/apply journal, expected-revision checks, repeat-safe writes, readback verification, compensating restoration with intervening-change detection; single-process/profile ownership; package as working stdio MCP and Codex plugin.

P3: encrypted libraries using official crypto/core when feasible; compatibility checks against the deployed Joplin Server and an official client; full shared-notebook semantics; delta optimization, indexed search, attachment uploads and advanced notebook restructuring. If P3 cannot be completed in the first implementation pass, it must remain prominently listed as unsupported rather than silently degraded.

P0–P2 implementation is present. Local fixtures and actual MCP subprocess tests verify the implemented baseline. Deployment still requires the live-account acceptance check below; P3 is not implemented. Codex packaging lives in `plugins/joplin-direct-mcp/` and requires explicit machine-local path configuration before installation.

## Security and reliability contract

Default read-only. User can enable ordinary write operations in local config. Scope is enforced in service code for all tools, not merely skills. Exact notebook ID allowlist; no implied recursive inclusion. No hard-delete MCP tool. Tag removal deletes a note-tag relationship only. Skills treat note content as data, never as agent instructions.

HTTPS is the default. Explicit `allowInsecureHttp` permits self-hosted HTTP on any host; the legacy `allowInsecureLocalhost` option remains limited to loopback. HTTP carries credentials and content without transport encryption. Deny redirects that could leak session headers. No arbitrary URLs/paths passed by a tool. Credentials sourced from environment or user-local config and never returned. State directory contains plaintext snapshots/before-images and must be treated as sensitive local data.

Every write persists intent and before/after bytes before sending. Unknown network outcomes reconcile against expected before/after content. Never blindly retry a non-idempotent mutation. Refresh/revision comparisons reduce stale edits but do not provide server-side compare-and-swap: an external write between check and PUT remains a documented race. Multi-item changes can partially succeed; journal results and recover without falsely claiming rollback transactions.

## Configuration

JOPLIN_SERVER_URL, JOPLIN_EMAIL, JOPLIN_PASSWORD, JOPLIN_STATE_DIR; JOPLIN_READ_ONLY defaults true; JOPLIN_ALLOWED_NOTEBOOK_IDS is comma-separated IDs or omitted for whole account; JOPLIN_ALLOW_INSECURE_HTTP defaults false and enables HTTP on any host; JOPLIN_ALLOW_INSECURE_LOCALHOST defaults false and enables loopback HTTP only; JOPLIN_REQUEST_TIMEOUT_MS defaults 30000. Optional --config points to JSON with ClientConfig field names. Environment values override JSON. No password in command arguments. E2EE configuration will be added only alongside functional encryption support.

## Acceptance and evidence

- Unit tests: serialization preserves body/newlines/unknown fields; config validation; scope checks; invalid IDs and target capability gates.
- Local HTTP protocol fixture: real authentication/header/path behavior, pagination, deadlines, remote errors, no secret leakage; no desktop required.
- Client tests: refresh all-or-nothing, read-only, scope, stale plans, retry after uncertain write, interruption and restart, partial operation recovery, restoration conflicts and resource association.
- Real MCP stdio process: initialize, list_tools, call search/get/preview/apply, verify remote fixture state; stdout parseable.
- Actual Joplin interoperability: optional integration command against an explicitly configured disposable test account, checked with an official client. This remains unproven until real server credentials/environment exist; fixture tests must not be described as real Joplin Server certification.
- Build/typecheck and plugin/skill validators pass. README distinguishes shipped capabilities and roadmap.

## Non-goals for v0.1

Desktop UI parity, running desktop plugins, OCR, publishing/sharing administration, server database access, permanent deletion, automatic sync-target upgrades, changing encryption settings, public remote MCP hosting, autonomous whole-library reorganization.

## Research sources

- https://github.com/laurent22/joplin/blob/dev/packages/lib/JoplinServerApi.ts
- https://github.com/laurent22/joplin/blob/dev/packages/lib/file-api-driver-joplinServer.ts
- https://github.com/laurent22/joplin/blob/dev/packages/server/src/routes/api/items.ts
- https://joplinapp.org/help/dev/spec/sync/
- https://joplinapp.org/help/dev/spec/server_delta_sync/
- https://joplinapp.org/help/dev/spec/e2ee/

Production wire behavior must be tied to a stable upstream tag/source fixture during implementation. Initial research links describe current upstream and are not a version support claim.
