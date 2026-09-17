import type { ClientConfig, RemotePage, ServerTransport } from './contracts.js';

type JsonObject = Record<string, unknown>;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const CLIENT_VERSION = '0.1.0';

function applicationPlatform(): number {
  if (process.platform === 'win32') return 1;
  if (process.platform === 'linux') return 2;
  if (process.platform === 'darwin') return 3;
  return 0;
}

export class JoplinTransportError extends Error {
  readonly status: number | undefined;
  readonly operation: string;

  public constructor(operation: string, message: string, status?: number) {
    super(message);
    this.name = 'JoplinTransportError';
    this.operation = operation;
    this.status = status;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function validateServerUrl(value: string, allowInsecureLocalhost: boolean, allowInsecureHttp: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid Joplin server URL');
  }
  const secure = parsed.protocol === 'https:';
  if (!secure && !(parsed.protocol === 'http:' && (allowInsecureHttp || (allowInsecureLocalhost && isLoopback(parsed.hostname))))) {
    throw new Error('Joplin server URL must use HTTPS unless HTTP is explicitly enabled');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Joplin server URL must not contain credentials or query parameters');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed;
}

/**
 * Validate a server item name before putting it into a URL path. Joplin's
 * sync names are relative slash-separated names (for example `.resource/<id>`).
 * Rejecting ambiguous path syntax avoids traversal and route escaping.
 */
function itemName(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 1024) throw new Error('Invalid Joplin item name');
  if (name.startsWith('/') || name.endsWith('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('Invalid Joplin item name');
  }
  const parts = name.split('/');
  if (parts.some(part => part.length === 0 || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) throw new Error('Invalid Joplin item name');
  return parts.join('/');
}

function safeError(operation: string, error: unknown): JoplinTransportError {
  if (error instanceof JoplinTransportError) return error;
  if (error instanceof Error && error.name === 'AbortError') return new JoplinTransportError(operation, 'Joplin request timed out');
  return new JoplinTransportError(operation, 'Joplin request failed');
}

function pageFromJson(value: unknown): RemotePage {
  if (!isObject(value) || !Array.isArray(value.items) || typeof value.has_more !== 'boolean') {
    throw new Error('invalid page response');
  }
  const items = value.items.map(entry => {
    if (!isObject(entry) || typeof entry.name !== 'string') throw new Error('invalid page item');
    const name = itemName(entry.name);
    if (entry.updated_time !== undefined && (typeof entry.updated_time !== 'number' || !Number.isFinite(entry.updated_time))) {
      throw new Error('invalid page timestamp');
    }
    return entry.updated_time === undefined ? { name } : { name, updated_time: entry.updated_time };
  });
  if (value.cursor !== undefined && value.cursor !== null && typeof value.cursor !== 'string') throw new Error('invalid page cursor');
  return typeof value.cursor !== 'string'
    ? { items, has_more: value.has_more }
    : { items, has_more: value.has_more, cursor: value.cursor };
}

function sessionFromJson(value: unknown): { id: string; user_id: string } {
  if (!isObject(value) || typeof value.id !== 'string' || value.id.length === 0 || typeof value.user_id !== 'string' || value.user_id.length === 0) {
    throw new Error('invalid session response');
  }
  return { id: value.id, user_id: value.user_id };
}

export class JoplinServerTransport implements ServerTransport {
  private readonly config: ClientConfig;
  private readonly baseUrl: URL;
  private session: { id: string; user_id: string } | null = null;
  private authentication: Promise<{ id: string; user_id: string }> | null = null;
  private readonly responseStates = new WeakMap<Response, { timer: ReturnType<typeof setTimeout> }>();

  public constructor(config: ClientConfig) {
    if (!config || typeof config.email !== 'string' || config.email.length === 0 || typeof config.password !== 'string' || config.password.length === 0) throw new Error('Joplin credentials are required');
    if (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) throw new Error('Invalid Joplin request timeout');
    this.config = config;
    this.baseUrl = validateServerUrl(config.serverUrl, config.allowInsecureLocalhost, config.allowInsecureHttp === true);
  }

  private url(path: string, query?: string): string {
    const output = new URL(this.baseUrl.toString());
    const root = this.baseUrl.pathname.replace(/\/+$/, '');
    output.pathname = `${root}/${path}`;
    if (query) output.search = query;
    else output.search = '';
    output.hash = '';
    if (output.origin !== this.baseUrl.origin) throw new Error('Invalid Joplin request URL');
    return output.toString();
  }

  private async request(operation: string, method: string, path: string, options: { body?: BodyInit; contentType?: string; query?: string; auth?: boolean } = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    let handedOff = false;
    const headers = new Headers();
    headers.set('X-API-MIN-VERSION', '2.6.0');
    if (options.contentType) headers.set('Content-Type', options.contentType);
    if (options.auth !== false && this.session) headers.set('X-API-AUTH', this.session.id);
    try {
      const init: RequestInit = {
        method,
        headers,
        redirect: 'error',
        signal: controller.signal,
      };
      if (options.body !== undefined) init.body = options.body;
      const response = await fetch(this.url(path, options.query), init);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new JoplinTransportError(operation, 'Joplin server redirect rejected', response.status);
      }
      if (!response.ok) {
        if (options.auth !== false && (response.status === 401 || response.status === 403)) this.session = null;
        await response.body?.cancel().catch(() => undefined);
        throw new JoplinTransportError(operation, `Joplin server returned HTTP ${response.status}`, response.status);
      }
      this.responseStates.set(response, { timer });
      handedOff = true;
      return response;
    } catch (error) {
      throw safeError(operation, error);
    } finally {
      if (!handedOff) clearTimeout(timer);
    }
  }

  private releaseResponse(response: Response): void {
    const state = this.responseStates.get(response);
    if (!state) return;
    clearTimeout(state.timer);
    this.responseStates.delete(response);
  }

  private async responseText(operation: string, response: Response): Promise<string> {
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
      await response.body?.cancel().catch(() => undefined);
      this.releaseResponse(response);
      throw new JoplinTransportError(operation, 'Joplin response is too large');
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(await this.readResponseBytes(operation, response));
    } catch (error) {
      throw safeError(operation, error);
    } finally {
      this.releaseResponse(response);
    }
  }

  private async responseBytes(operation: string, response: Response): Promise<Uint8Array> {
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
      await response.body?.cancel().catch(() => undefined);
      this.releaseResponse(response);
      throw new JoplinTransportError(operation, 'Joplin response is too large');
    }
    try {
      return await this.readResponseBytes(operation, response);
    } catch (error) {
      throw safeError(operation, error);
    } finally {
      this.releaseResponse(response);
    }
  }

  private async readResponseBytes(operation: string, response: Response): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value;
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new JoplinTransportError(operation, 'Joplin response is too large');
        }
        chunks.push(chunk);
      }
    } catch (error) {
      throw safeError(operation, error);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  }

  private async discardResponse(operation: string, response: Response): Promise<void> {
    await this.responseBytes(operation, response);
  }

  private async authenticate(): Promise<{ id: string; user_id: string }> {
    if (this.session) return this.session;
    if (this.authentication) return this.authentication;
    this.authentication = (async () => {
      let response: Response;
      try {
        response = await this.request('authenticate', 'POST', 'api/sessions', {
          auth: false,
          contentType: 'application/json',
          body: JSON.stringify({
            email: this.config.email,
            password: this.config.password,
            platform: applicationPlatform(),
            type: 3,
            version: CLIENT_VERSION,
          }),
        });
      } catch (error) {
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await this.responseText('authenticate', response));
      } catch {
        throw new JoplinTransportError('authenticate', 'Invalid Joplin session response');
      }
      try {
        const session = sessionFromJson(parsed);
        this.session = session;
        return session;
      } catch {
        throw new JoplinTransportError('authenticate', 'Invalid Joplin session response');
      }
    })();
    try {
      return await this.authentication;
    } finally {
      this.authentication = null;
    }
  }

  private async authenticatedRequest(operation: string, method: string, path: string, options: { contentType?: string; body?: BodyInit; query?: string } = {}): Promise<Response> {
    await this.authenticate();
    try {
      return await this.request(operation, method, path, options);
    } catch (error) {
      // A read can be safely replayed after a server-invalidated session. A
      // mutation is surfaced to the caller so an unknown write outcome is
      // never replayed automatically.
      if (method === 'GET' && error instanceof JoplinTransportError && (error.status === 401 || error.status === 403)) {
        this.session = null;
        await this.authenticate();
        return this.request(operation, method, path, options);
      }
      throw error;
    }
  }

  public async listItems(cursor?: string): Promise<RemotePage> {
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 4096)) throw new Error('Invalid Joplin pagination cursor');
    const response = await this.authenticatedRequest('list items', 'GET', 'api/items/root:/:/children', cursor === undefined ? {} : { query: `cursor=${encodeURIComponent(cursor)}` });
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.responseText('list items', response));
    } catch {
      throw new JoplinTransportError('list items', 'Invalid Joplin page response');
    }
    try {
      return pageFromJson(parsed);
    } catch {
      throw new JoplinTransportError('list items', 'Invalid Joplin page response');
    }
  }

  public async getContent(name: string): Promise<Uint8Array | null> {
    const pathName = itemName(name);
    try {
      const response = await this.authenticatedRequest('get content', 'GET', `api/items/root:/${pathName}:/content`);
      return await this.responseBytes('get content', response);
    } catch (error) {
      if (error instanceof JoplinTransportError && error.status === 404) return null;
      throw error;
    }
  }

  public async putContent(name: string, content: Uint8Array): Promise<void> {
    if (this.config.readOnly) throw new Error('Joplin transport is read-only');
    const pathName = itemName(name);
    if (!(content instanceof Uint8Array)) throw new Error('Joplin content must be bytes');
    const response = await this.authenticatedRequest('put content', 'PUT', `api/items/root:/${pathName}:/content`, {
      contentType: 'application/octet-stream',
      body: content as unknown as BodyInit,
    });
    await this.discardResponse('put content', response);
  }

  public async deleteItem(name: string): Promise<void> {
    if (this.config.readOnly) throw new Error('Joplin transport is read-only');
    const pathName = itemName(name);
    const response = await this.authenticatedRequest('delete item', 'DELETE', `api/items/root:/${pathName}:`);
    await this.discardResponse('delete item', response);
  }
}
