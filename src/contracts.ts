export type ItemKind = 1 | 2 | 4 | 5 | 6;
/** Lossless wire representation: all metadata, including unknown properties, survives updates. */
export interface JoplinItem {
  id: string;
  type_: number;
  title: string;
  body: string;
  properties: Record<string, string>;
}
export interface RemoteEntry { name: string; updated_time?: number; }
export interface RemotePage { items: RemoteEntry[]; has_more: boolean; cursor?: string; }
export interface ServerTransport {
  listItems(cursor?: string): Promise<RemotePage>;
  getContent(name: string): Promise<Uint8Array | null>;
  putContent(name: string, content: Uint8Array): Promise<void>;
  deleteItem(name: string): Promise<void>;
}
export interface ClientConfig {
  serverUrl: string;
  email: string;
  password: string;
  stateDir: string;
  allowInsecureLocalhost: boolean;
  allowInsecureHttp?: boolean;
  readOnly: boolean;
  allowedNotebookIds: string[] | null;
  requestTimeoutMs: number;
}
export type NotePatch = { title?: string; body?: string; parent_id?: string; is_todo?: number; todo_due?: number; todo_completed?: number };
export type Change =
  | { kind: 'create_note'; notebookId: string; title: string; body: string }
  | { kind: 'update_note'; noteId: string; expectedRevision: string; patch: NotePatch }
  | { kind: 'create_notebook'; title: string; parentId?: string }
  | { kind: 'rename_notebook'; notebookId: string; expectedRevision: string; title: string }
  | { kind: 'move_notebook'; notebookId: string; expectedRevision: string; parentId: string }
  | { kind: 'tag_note'; noteId: string; expectedRevision: string; tagTitle: string; remove?: boolean }
  | { kind: 'trash_note'; noteId: string; expectedRevision: string };
export interface ClientOperations {
  status(): Promise<unknown>;
  sync(): Promise<unknown>;
  listNotebooks(): Promise<unknown>;
  listTags(): Promise<unknown>;
  searchNotes(args: { query: string; notebookId?: string; offset?: number; limit?: number }): Promise<unknown>;
  getNote(id: string): Promise<unknown>;
  getResource(args: { noteId: string; resourceId: string }): Promise<unknown>;
  previewChanges(changes: Change[]): Promise<unknown>;
  applyChanges(planId: string): Promise<unknown>;
  getOperation(operationId: string): Promise<unknown>;
  restoreOperation(operationId: string): Promise<unknown>;
}
