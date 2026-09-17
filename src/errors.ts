export type ClientErrorCode =
  | 'unsupported' | 'read_only' | 'scope' | 'stale_revision' | 'conflict'
  | 'not_found' | 'invalid_state' | 'invalid_input';

/** Safe, user-facing errors that the MCP layer may expose verbatim. */
export class ClientError extends Error {
  public constructor(public readonly code: ClientErrorCode, message: string) {
    super(message);
    this.name = 'ClientError';
  }
}
