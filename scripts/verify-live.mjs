#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const configPath = process.argv[2];
const errorDetails = result => {
  const block = result.content?.find(value => value.type === 'text');
  if (!block) return 'No diagnostic details were returned.';
  try {
    const value = JSON.parse(block.text);
    return [value.error, value.operation, value.message].filter(part => typeof part === 'string').join(': ');
  } catch { return 'The diagnostic response was invalid.'; }
};
if (!configPath) {
  process.stderr.write('Usage: node scripts/verify-live.mjs <user-local-config.json>\nThis performs remote reads only and reports counts, not note content.\n');
  process.exitCode = 1;
} else {
  const client = new Client({ name: 'joplin-direct-live-verifier', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--config', resolve(configPath)],
    env: { ...process.env, JOPLIN_READ_ONLY: 'true' },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    process.stdout.write('Authenticated. Downloading and validating the server inventory; large libraries may take several minutes.\n');
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      process.stdout.write(`Still downloading and validating the inventory (${seconds}s elapsed)...\n`);
    }, 15_000);
    let refreshed;
    try {
      refreshed = await client.callTool({ name: 'sync', arguments: {} }, undefined, { timeout: 300_000 });
    } finally {
      clearInterval(heartbeat);
    }
    if (refreshed.isError) throw new Error(`Remote inventory failed: ${errorDetails(refreshed)}`);
    const content = refreshed.content?.find(block => block.type === 'text');
    const summary = content ? JSON.parse(content.text) : null;
    if (!summary || typeof summary !== 'object' || typeof summary.visibleNotes !== 'number') throw new Error('Unexpected MCP result.');
    process.stdout.write(JSON.stringify({ result: 'read-only-live-check-passed', toolCount: tools.tools.length, visibleNoteCount: summary.visibleNotes, writesPerformed: 0 }, null, 2) + '\n');
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown failure';
    process.stderr.write(`Live verification failed: ${detail}\nCredentials, session tokens, upstream response bodies, and note content are intentionally omitted.\n`);
    process.exitCode = 1;
  } finally { await client.close(); }
}
