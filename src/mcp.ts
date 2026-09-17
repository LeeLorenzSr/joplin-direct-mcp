import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { Change, ClientOperations } from './contracts.js';
import { ClientError } from './errors.js';
import { JoplinTransportError } from './transport.js';

const id = z.string().regex(/^[a-f0-9]{32}$/, 'must be a 32-character lowercase hexadecimal ID');
const operationId = z.string().uuid();
const title = z.string().min(1).max(1000).regex(/^[^\r\n]*$/, 'must be a single line');
const body = z.string().max(10_000_000);
const revision = z.string().trim().min(1).max(512);
const notePatch = z.object({
  title: title.optional(), body: body.optional(), parent_id: id.optional(),
  is_todo: z.number().int().min(0).max(1).optional(),
  todo_due: z.number().int().nonnegative().safe().optional(),
  todo_completed: z.number().int().nonnegative().safe().optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'patch must change at least one field');

const changes = z.array(z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create_note'), notebookId: id, title, body }).strict(),
  z.object({ kind: z.literal('update_note'), noteId: id, expectedRevision: revision, patch: notePatch }).strict(),
  z.object({ kind: z.literal('create_notebook'), title, parentId: id.optional() }).strict(),
  z.object({ kind: z.literal('rename_notebook'), notebookId: id, expectedRevision: revision, title }).strict(),
  z.object({ kind: z.literal('move_notebook'), notebookId: id, expectedRevision: revision, parentId: id }).strict(),
  z.object({ kind: z.literal('tag_note'), noteId: id, expectedRevision: revision, tagTitle: title.min(1), remove: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('trash_note'), noteId: id, expectedRevision: revision }).strict()
])).min(1).max(100);

const descriptions = {
  status: 'Report configured mode and local snapshot status. Baseline supports plaintext personal libraries only; encrypted, shared and locked items are unsupported.',
  sync: 'Refresh the complete online snapshot. Search is literal title/body search; Joplin search syntax is not supported.',
  list_notebooks: 'List notebooks visible under the configured exact notebook allowlist.',
  list_tags: 'List tags in the visible plaintext personal library.',
  search_notes: 'Search note titles and bodies using a bounded literal plaintext query, with offset pagination.',
  get_note: 'Read one note by stable ID, including its full plaintext body and opaque revision.',
  get_resource: 'Retrieve one bounded attachment linked from a note by stable IDs.',
  preview_changes: 'Validate and prepare an auditable exact change plan. Preparation does not write to Joplin.',
  apply_changes: 'Apply a prepared plan after revision checks, readback verification and operation journaling. Writes remain subject to read-only and scope policy.',
  get_operation: 'Read the journaled result of a change operation.',
  restore_operation: 'Restore an operation using its journaled before-images when intervening changes are absent.'
} as const;

function jsonText(value: unknown): string {
  try { return JSON.stringify(value ?? null); } catch { return JSON.stringify({ error: 'result_not_serializable' }); }
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: jsonText(value) }] };
}

function failure() {
  // Keep upstream URLs, response bodies, credentials and implementation details out of MCP output.
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'operation_failed' }) }] };
}

function failureFor(error: unknown) {
  if (error instanceof ClientError) {
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: error.code, message: error.message }) }] };
  }
  if (error instanceof JoplinTransportError) {
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'transport_failed', operation: error.operation, message: error.message }) }] };
  }
  return failure();
}

async function safe<T>(operation: () => Promise<T>) {
  try { return result(await operation()); } catch (error) { return failureFor(error); }
}

export const MCP_TOOL_NAMES = [
  'status', 'sync', 'list_notebooks', 'list_tags', 'search_notes', 'get_note', 'get_resource',
  'preview_changes', 'apply_changes', 'get_operation', 'restore_operation'
] as const;

export function createMcpServer(client: ClientOperations): McpServer {
  const server = new McpServer({ name: 'joplin-direct-mcp', version: '0.1.0' });
  server.registerTool('status', { description: descriptions.status, inputSchema: {}, annotations: { readOnlyHint: true, idempotentHint: true } }, () => safe(() => client.status()));
  server.registerTool('sync', { description: descriptions.sync, inputSchema: {}, annotations: { readOnlyHint: true, idempotentHint: true } }, () => safe(() => client.sync()));
  server.registerTool('list_notebooks', { description: descriptions.list_notebooks, inputSchema: {}, annotations: { readOnlyHint: true, idempotentHint: true } }, () => safe(() => client.listNotebooks()));
  server.registerTool('list_tags', { description: descriptions.list_tags, inputSchema: {}, annotations: { readOnlyHint: true, idempotentHint: true } }, () => safe(() => client.listTags()));
  server.registerTool('search_notes', {
    description: descriptions.search_notes,
    inputSchema: { query: z.string().min(1).max(10_000), notebookId: id.optional(), offset: z.number().int().min(0).max(10_000_000).optional(), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true, idempotentHint: true }
  }, (args) => safe(() => client.searchNotes({
    query: args.query,
    ...(args.notebookId === undefined ? {} : { notebookId: args.notebookId }),
    ...(args.offset === undefined ? {} : { offset: args.offset }),
    ...(args.limit === undefined ? {} : { limit: args.limit })
  })));
  server.registerTool('get_note', { description: descriptions.get_note, inputSchema: { id }, annotations: { readOnlyHint: true, idempotentHint: true } }, ({ id: noteId }) => safe(() => client.getNote(noteId)));
  server.registerTool('get_resource', { description: descriptions.get_resource, inputSchema: { noteId: id, resourceId: id }, annotations: { readOnlyHint: true, idempotentHint: true } }, (args) => safe(() => client.getResource(args)));
  server.registerTool('preview_changes', { description: descriptions.preview_changes, inputSchema: { changes }, annotations: { readOnlyHint: true, idempotentHint: true } }, ({ changes: requested }) => safe(() => client.previewChanges(requested as Change[])));
  server.registerTool('apply_changes', { description: descriptions.apply_changes, inputSchema: { planId: operationId }, annotations: { destructiveHint: true, idempotentHint: true, readOnlyHint: false } }, ({ planId }) => safe(() => client.applyChanges(planId)));
  server.registerTool('get_operation', { description: descriptions.get_operation, inputSchema: { operationId }, annotations: { readOnlyHint: true, idempotentHint: true } }, ({ operationId: operation }) => safe(() => client.getOperation(operation)));
  server.registerTool('restore_operation', { description: descriptions.restore_operation, inputSchema: { operationId }, annotations: { destructiveHint: true, idempotentHint: true, readOnlyHint: false } }, ({ operationId: operation }) => safe(() => client.restoreOperation(operation)));
  return server;
}
