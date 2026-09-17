import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('Codex plugin launcher starts the built CLI without variable interpolation', { timeout: 15_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'joplin-plugin-launcher-'));
  const project = resolve('.');
  const pluginRoot = resolve('plugins/joplin-direct-mcp');
  const configPath = join(temp, 'config.json');
  await writeFile(configPath, JSON.stringify({
    serverUrl: 'https://joplin.example.test', email: 'test@example.test', password: 'local-secret',
    stateDir: join(temp, 'state'), readOnly: true, allowInsecureLocalhost: false,
    allowedNotebookIds: null, requestTimeoutMs: 30000
  }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['launcher.mjs'],
    cwd: pluginRoot,
    env: { ...inherited, JOPLIN_MCP_PROJECT_DIR: project, JOPLIN_MCP_CONFIG: configPath },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'plugin-launcher-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 11);
    assert.equal(tools.tools.some((tool) => tool.name === 'apply_changes'), true);
  } finally {
    await client.close();
    await rm(temp, { recursive: true, force: true });
  }
});
