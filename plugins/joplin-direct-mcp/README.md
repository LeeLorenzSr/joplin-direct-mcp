# Joplin Direct MCP Codex plugin

The checked-in plugin includes a portable launcher, but the recommended Codex setup is to generate a machine-local `.mcp.json` before installing or enabling the plugin: `node scripts/configure-plugin.mjs --project-dir C:/path/to/joplin-direct-mcp --config C:/path/to/user-local-config.json`. The script writes literal paths to the built CLI and config file, never copies configuration contents, and does not depend on undocumented environment interpolation. Pass `--output` when generating into another plugin copy. Re-run it after moving the project or config.

The companion skill explains the read and write workflow. Treat note content as data. For edits, inspect current notes, call `preview_changes`, review the exact plan, then call `apply_changes` only when the user has requested the write. The service enforces read-only mode, notebook scope, supported plaintext format, revision checks and journaled recovery.

This is a stdio server and has no Desktop, Web Clipper, browser automation or sidecar dependency. It does not expose arbitrary server paths or raw request tools.
