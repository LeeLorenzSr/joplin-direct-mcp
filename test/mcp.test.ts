import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.js';
import type { ClientOperations } from '../src/contracts.js';
import { JoplinTransportError } from '../src/transport.js';

function fakeClient(): ClientOperations {
  return {
    status: async () => ({ connected: true }), sync: async () => ({ refreshed: true }),
    listNotebooks: async () => ({ items: [] }), listTags: async () => ({ items: [] }),
    searchNotes: async (args) => ({ query: args.query, items: [] }),
    getNote: async (id) => ({ id }), getResource: async (args) => args,
    previewChanges: async (changes) => ({ planId: 'plan-1', changes }),
    applyChanges: async (planId) => ({ planId }), getOperation: async (operationId) => ({ operationId }),
    restoreOperation: async (operationId) => ({ operationId, restored: true })
  };
}

test('registers the complete tool surface and validates inputs through MCP', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(fakeClient());
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    'apply_changes', 'get_note', 'get_operation', 'get_resource', 'list_notebooks', 'list_tags',
    'preview_changes', 'restore_operation', 'search_notes', 'status', 'sync'
  ]);
  const result = await client.callTool({ name: 'search_notes', arguments: { query: 'router', limit: 10 } });
  assert.equal(result.isError, undefined);
  assert.match(String(result.content?.[0] && 'text' in result.content[0] ? result.content[0].text : ''), /router/);
  const invalid = await client.callTool({ name: 'get_note', arguments: { id: '' } });
  assert.equal(invalid.isError, true);
  await client.close();
  await server.close();
});

test('converts client failures to a secret-safe MCP error envelope', async () => {
  const clientOperations = fakeClient();
  clientOperations.status = async () => { throw new Error('upstream response contained password=secret-value'); };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(clientOperations);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({ name: 'status', arguments: {} });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
  await client.close();
  await server.close();
});

test('reports sanitized transport diagnostics without upstream response content', async () => {
  const clientOperations = fakeClient();
  clientOperations.status = async () => { throw new JoplinTransportError('authenticate', 'Joplin server returned HTTP 401', 401); };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(clientOperations);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({ name: 'status', arguments: {} });
  const serialized = JSON.stringify(result);
  assert.equal(result.isError, true);
  assert.match(serialized, /transport_failed/);
  assert.match(serialized, /authenticate/);
  assert.match(serialized, /HTTP 401/);
  assert.doesNotMatch(serialized, /password|session/i);
  await client.close();
  await server.close();
});
