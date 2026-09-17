import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile);

test('configure-plugin writes literal paths and the generated MCP server starts', { timeout: 15_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'joplin-plugin-configure-'));
  const configPath = join(temp, 'config.json');
  const output = join(temp, 'generated', '.mcp.json');
  await writeFile(configPath, JSON.stringify({ serverUrl: 'https://joplin.example.test', email: 'test@example.test', password: 'local-secret', stateDir: join(temp, 'state'), readOnly: true, allowInsecureLocalhost: false, allowedNotebookIds: null, requestTimeoutMs: 30000 }));
  try {
    await run(process.execPath, ['scripts/configure-plugin.mjs', '--project-dir', resolve('.'), '--config', configPath, '--output', output], { cwd: resolve('.') });
    const generated = JSON.parse(await readFile(output, 'utf8'));
    const server = generated.mcpServers['joplin-direct'];
    assert.equal(server.command, process.execPath);
    assert.deepEqual(server.args, [resolve('dist/cli.js'), '--config', resolve(configPath)]);
    assert.equal(JSON.stringify(generated).includes('local-secret'), false);
    const transport = new StdioClientTransport({ command: server.command, args: server.args, cwd: server.cwd, env: process.env as Record<string, string>, stderr: 'pipe' });
    const client = new Client({ name: 'generated-config-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 11);
    } finally {
      await client.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
