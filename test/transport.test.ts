import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import test from 'node:test';
import { JoplinServerTransport } from '../src/transport.js';
import type { ClientConfig } from '../src/contracts.js';

const config = (serverUrl: string, requestTimeoutMs = 1000, readOnly = false): ClientConfig => ({
  serverUrl, email: 'person@example.test', password: 'secret-password', stateDir: 'unused',
  allowInsecureLocalhost: true, readOnly, allowedNotebookIds: null, requestTimeoutMs,
});

test('explicit remote HTTP opt-in reaches authentication and inventory on the configured origin', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    calls.push(input);
    assert.equal(init.redirect, 'error');
    if (calls.length === 1) {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(String(init.body)), {
        email: 'person@example.test', password: 'secret-password',
        platform: process.platform === 'win32' ? 1 : process.platform === 'linux' ? 2 : process.platform === 'darwin' ? 3 : 0,
        type: 3, version: '0.1.0',
      });
      return Response.json({ id: 'http-session', user_id: 'user' });
    }
    assert.equal(new Headers(init.headers).get('X-API-AUTH'), 'http-session');
    return Response.json({ items: [], has_more: false });
  });
  const remote = { ...config('http://joplin.example.test:22300/subpath'), allowInsecureLocalhost: false, allowInsecureHttp: true };
  const transport = new JoplinServerTransport(remote);
  assert.deepEqual(await transport.listItems(), { items: [], has_more: false });
  assert.deepEqual(calls, ['http://joplin.example.test:22300/subpath/api/sessions', 'http://joplin.example.test:22300/subpath/api/items/root:/:/children']);
  assert.throws(() => new JoplinServerTransport({ ...remote, allowInsecureHttp: false }), /HTTPS/);
  assert.throws(() => new JoplinServerTransport({ ...remote, serverUrl: 'ftp://joplin.example.test' }), /HTTPS/);
});

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('failed to listen'));
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('transport authenticates, paginates, reads, writes and deletes against a loopback HTTP fixture', async t => {
  const calls: string[] = [];
  const fixture = await listen(async (request, response) => {
    calls.push(`${request.method} ${request.url}`);
    if (request.url === '/api/sessions' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request));
      assert.deepEqual(body, {
        email: 'person@example.test', password: 'secret-password',
        platform: process.platform === 'win32' ? 1 : process.platform === 'linux' ? 2 : process.platform === 'darwin' ? 3 : 0,
        type: 3, version: '0.1.0',
      });
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id: 'session', user_id: 'user' })); return;
    }
    assert.equal(request.headers['x-api-auth'], 'session');
    if (request.url?.startsWith('/api/items/root:/:/children') && request.method === 'GET') {
      response.setHeader('content-type', 'application/json');
      if (new URL(`http://fixture${request.url}`).searchParams.get('cursor') === 'next') response.end(JSON.stringify({ items: [], has_more: false, cursor: null }));
      else response.end(JSON.stringify({ items: [{ name: '0123456789abcdef0123456789abcdef.md', updated_time: 10 }], has_more: true, cursor: 'next' }));
      return;
    }
    if (request.url === '/api/items/root:/0123456789abcdef0123456789abcdef.md:/content' && request.method === 'GET') { response.end('note bytes'); return; }
    if (request.url === '/api/items/root:/.resource/0123456789abcdef0123456789abcdef:/content' && request.method === 'GET') { response.end(Buffer.from([1, 2, 3])); return; }
    if (request.method === 'PUT') { assert.equal(request.headers['content-type'], 'application/octet-stream'); void readBody(request); response.end('{}'); return; }
    if (request.method === 'DELETE') { response.statusCode = 204; response.end(); return; }
    response.statusCode = 404; response.end();
  });
  t.after(() => close(fixture.server));
  const transport = new JoplinServerTransport(config(fixture.url));
  assert.deepEqual(await transport.listItems(), { items: [{ name: '0123456789abcdef0123456789abcdef.md', updated_time: 10 }], has_more: true, cursor: 'next' });
  assert.deepEqual(await transport.listItems('next'), { items: [], has_more: false });
  assert.deepEqual(await transport.getContent('0123456789abcdef0123456789abcdef.md'), new TextEncoder().encode('note bytes'));
  assert.deepEqual(await transport.getContent('.resource/0123456789abcdef0123456789abcdef'), new Uint8Array([1, 2, 3]));
  await transport.putContent('0123456789abcdef0123456789abcdef.md', new Uint8Array([4]));
  await transport.deleteItem('0123456789abcdef0123456789abcdef.md');
  assert.equal(calls.filter(call => call === 'POST /api/sessions').length, 1);
});

test('transport returns null for missing content and rejects unsafe names or writes in read-only mode', async t => {
  const fixture = await listen((_request, response) => { response.statusCode = 404; response.end(); });
  t.after(() => close(fixture.server));
  const transport = new JoplinServerTransport(config(fixture.url, 1000, true));
  await assert.rejects(() => transport.getContent('../escape'), /Invalid Joplin item name/);
  await assert.rejects(() => transport.getContent('id:evil'), /Invalid Joplin item name/);
  await assert.rejects(() => transport.putContent('a.md', new Uint8Array()), /read-only/);
  await assert.rejects(() => transport.deleteItem('a.md'), /read-only/);
});

test('transport deadline covers a delayed response', async t => {
  const fixture = await listen((_request, response) => { setTimeout(() => response.end('{}'), 100); });
  t.after(() => close(fixture.server));
  const transport = new JoplinServerTransport(config(fixture.url, 20));
  await assert.rejects(() => transport.listItems(), /timed out|failed/);
});

test('transport deadline covers a response body that stalls after headers', async t => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    setTimeout(() => response.end(JSON.stringify({ items: [], has_more: false })), 100);
  });
  t.after(() => close(fixture.server));
  const transport = new JoplinServerTransport(config(fixture.url, 20));
  await assert.rejects(() => transport.listItems(), /timed out|failed/);
});

test('transport keeps a configured base path on the same origin and rejects insecure non-loopback URLs', () => {
  assert.throws(() => new JoplinServerTransport(config('http://example.test')), /HTTPS/);
  assert.throws(() => new JoplinServerTransport(config('https://example.test/path?secret=1')), /query/);
  const transport = new JoplinServerTransport(config('http://127.0.0.1:1234/joplin'));
  assert.equal((transport as unknown as { url(path: string): string }).url('api/sessions'), 'http://127.0.0.1:1234/joplin/api/sessions');
});

test('transport never includes credentials or upstream body in errors', async t => {
  const fixture = await listen((_request, response) => { response.statusCode = 500; response.end('password=secret-password and private upstream detail'); });
  t.after(() => close(fixture.server));
  const transport = new JoplinServerTransport(config(fixture.url));
  await assert.rejects(() => transport.listItems(), error => {
    assert.equal(error instanceof Error, true);
    assert.equal((error as Error).message.includes('secret-password'), false);
    assert.equal((error as Error).message.includes('private upstream detail'), false);
    return true;
  });
});
