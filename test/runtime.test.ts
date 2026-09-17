import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const folderId = 'a'.repeat(32);
const noteId = 'b'.repeat(32);
const plainFolder = `Inbox\n\nid: ${folderId}\nparent_id: \ncreated_time: 2026-09-01T00:00:00.000Z\nupdated_time: 2026-09-01T00:00:00.000Z\nuser_created_time: 2026-09-01T00:00:00.000Z\nuser_updated_time: 2026-09-01T00:00:00.000Z\nencryption_cipher_text: \nencryption_applied: 0\ntype_: 2`;
const plainNote = `Router setup\n\nUse the blue cable.\n\nid: ${noteId}\nparent_id: ${folderId}\ncreated_time: 2026-09-01T00:00:00.000Z\nupdated_time: 2026-09-01T00:00:00.000Z\nuser_created_time: 2026-09-01T00:00:00.000Z\nuser_updated_time: 2026-09-01T00:00:00.000Z\nis_todo: 0\ntodo_due: 0\ntodo_completed: 0\nmarkup_language: 1\nencryption_cipher_text: \nencryption_applied: 0\ntype_: 1`;

test('built CLI speaks MCP over stdio and edits direct-server HTTP data without Desktop', { timeout: 30_000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), 'joplin-mcp-runtime-'));
  const data = new Map<string, string>([
    ['info.json', JSON.stringify({ version: 3, e2ee: { value: false, updatedTime: 0 }, appMinVersion: '3.7.0' })],
    [`${folderId}.md`, plainFolder], [`${noteId}.md`, plainNote],
  ]);
  let sessions = 0;
  let writes = 0;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://localhost');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      const respond = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        assert.deepEqual(JSON.parse(body), {
          email: 'test@example.invalid', password: ' test-secret ', platform: 1, type: 3, version: '0.1.0',
        });
        sessions++; respond(200, { id: 'test-session', user_id: 'test-user' }); return;
      }
      if (req.headers['x-api-auth'] !== 'test-session') { respond(403, { error: 'Unauthorized' }); return; }
      if (url.pathname === '/api/items/root:/:/children') {
        const all = [...data.keys()].filter(n => n.endsWith('.md'));
        const cursor = Number(url.searchParams.get('cursor') || 0);
        respond(200, { items: all.slice(cursor, cursor + 1).map(name => ({ name })), has_more: cursor + 1 < all.length, cursor: String(cursor + 1) }); return;
      }
      const matched = /^\/api\/items\/root:\/(.*):\/content$/.exec(decodeURI(url.pathname));
      if (matched) {
        const name = matched[1]!;
        if (req.method === 'GET') {
          const value = data.get(name);
          if (value === undefined) { respond(404, { error: 'Not found' }); return; }
          res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(value); return;
        }
        if (req.method === 'PUT') {
          assert.equal(req.headers['content-type'], 'application/octet-stream');
          data.set(name, body); writes++; respond(200, { name }); return;
        }
      }
      respond(404, { error: 'Unsupported fixture route' });
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve('dist/cli.js')], stderr: 'pipe',
    env: { ...env, JOPLIN_SERVER_URL: `http://127.0.0.1:${address.port}`, JOPLIN_EMAIL: 'test@example.invalid', JOPLIN_PASSWORD: ' test-secret ', JOPLIN_STATE_DIR: state, JOPLIN_ALLOW_INSECURE_LOCALHOST: 'false', JOPLIN_ALLOW_INSECURE_HTTP: 'true', JOPLIN_READ_ONLY: 'false' },
  });
  const client = new Client({ name: 'runtime-test', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(Array.isArray(result.content));
    const content = result.content[0]; assert.ok(content && content.type === 'text');
    return JSON.parse(content.text) as Record<string, any>;
  };
  try {
    await client.connect(transport);
    const list = await client.listTools(); assert.equal(list.tools.length, 11);
    const search = await call('search_notes', { query: 'router' });
    assert.equal(search.items[0].id, noteId);
    const note = await call('get_note', { id: noteId });
    assert.equal(note.body, 'Use the blue cable.');
    const plan = await call('preview_changes', { changes: [{ kind: 'update_note', noteId, expectedRevision: note.revision, patch: { body: 'Use the green cable.' } }] });
    assert.equal(writes, 0);
    const applied = await call('apply_changes', { planId: plan.planId });
    assert.equal(applied.status, 'completed'); assert.equal(writes, 1);
    assert.ok(data.get(`${noteId}.md`)!.includes('Use the green cable.'));
    await call('apply_changes', { planId: plan.planId }); assert.equal(writes, 1);
    const restored = await call('restore_operation', { operationId: plan.planId });
    assert.equal(restored.status, 'completed'); assert.equal(writes, 2);
    assert.equal((await call('get_note', { id: noteId })).body, 'Use the blue cable.');
    assert.equal(sessions, 1);
  } finally {
    await client.close();
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    assert.ok(!stderr.includes('test-secret'), 'secret appeared in stderr');
    // Graceful EOF should release ownership, allowing a new MCP process to use the profile.
    for (let i = 0; i < 20; i++) {
      try { await stat(join(state, 'owner.lock')); await new Promise(r => setTimeout(r, 25)); }
      catch { break; }
    }
    const locked = await stat(join(state, 'owner.lock')).then(() => true, () => false);
    await rm(state, { recursive: true, force: true });
    assert.equal(locked, false, 'CLI left an owner lock after MCP disconnect');
  }
});
