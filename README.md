# Joplin Direct MCP Client

This project provides a stdio MCP server that talks directly to Joplin Server with configured credentials. It supports an online plaintext personal-library baseline: inventory refresh, notebooks, tags, literal title/body search, full note reads, bounded linked-resource reads, and journaled preview/apply operations for note changes plus notebook creation, rename, and reparenting.

The service uses HTTPS by default; self-hosted HTTP servers are supported with `allowInsecureHttp: true` in JSON or `JOPLIN_ALLOW_INSECURE_HTTP=true`. HTTP carries credentials and notes without transport encryption. The client authenticates through Joplin Server sessions, keeps a complete local snapshot, and applies an exact notebook allowlist to tool reads and writes. The allowlist does not prevent full inventory retrieval into the local snapshot; use a dedicated Joplin account when that separation matters. State files include plaintext notes and before-images and must be protected as sensitive local data.

Writes are disabled by default. To enable a write, set `readOnly` to `false` and use `preview_changes` before `apply_changes`. The journal records per-item outcomes and verifies revisions and readback. There is no server-side compare-and-swap or global transaction, so concurrent edits and partial multi-item success remain possible. There is no hard-delete tool.

## Setup

Build with `npm install` and `npm run build`. Copy `config.example.json` to a user-local path and replace the example values. A password may also be supplied with `JOPLIN_PASSWORD`; it is never printed or returned. Start with `node dist/cli.js --config C:/path/to/config.json`, or supply `JOPLIN_*` environment variables. `JOPLIN_CONFIG_PATH` and `JOPLIN_MCP_CONFIG` are supported for plugin launchers.

Run `node scripts/diagnose.mjs C:/path/to/config.json` to check configuration presence and URL policy without printing secrets. `npm test` builds the application and runs transport, codec, client, configuration, MCP and plugin-launch tests. The real stdio runtime fixture test proves protocol framing and lock cleanup; interoperability with a real disposable Joplin Server account remains pending until credentials and an explicit test environment are supplied.

For an initial live read-only check, run `node scripts/verify-live.mjs C:/path/to/config.json`. It forces remote writes off and reports counts without printing note content. It downloads the account inventory into the configured state directory; stop other processes using that directory first. This checks connectivity and reads, while write interoperability still needs a disposable account and round-trip verification with an official Joplin client.

See [the implementation specification](docs/SPEC.md) for the phased scope and acceptance criteria, and [the decisions](docs/DECISIONS.md) for compatibility and consistency boundaries.

## Plugin

The Codex plugin is under `plugins/joplin-direct-mcp/`. Before installing it, run `node scripts/configure-plugin.mjs --project-dir C:/path/to/joplin-direct-mcp --config C:/path/to/user-local-config.json`. This writes a machine-local `.mcp.json` with literal executable and config paths; it copies no credentials and requires no variable interpolation. Re-run after moving the project or config. No desktop sidecar is embedded. The skill documents scope, plaintext limitations and the preview/apply workflow.

## Architecture

`src/transport.ts` owns HTTP(S)/session and wire validation. `src/codec.ts` preserves serialized item metadata and bodies. `src/client.ts` owns snapshots, scope, revisions and journals. `src/mcp.ts` owns typed tool schemas and safe envelopes. `src/cli.ts` connects the MCP server to stdio.

Encrypted, shared, locked, conflicted and unsupported items remain unsupported in this baseline. Delta sync, uploads, E2EE, bulk hierarchy transforms and remote MCP hosting are roadmap work. There is no dependency on Joplin Desktop, Web Clipper, browser automation or a terminal sidecar.
