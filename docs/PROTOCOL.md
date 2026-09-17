# Direct Joplin Server protocol

This client implements the plaintext file API shape verified against the
Joplin repository tag `v3.7.18` (source files:
[`JoplinServerApi.ts`](https://github.com/laurent22/joplin/blob/v3.7.18/packages/lib/JoplinServerApi.ts),
[`file-api-driver-joplinServer.ts`](https://github.com/laurent22/joplin/blob/v3.7.18/packages/lib/file-api-driver-joplinServer.ts),
and [`items.ts`](https://github.com/laurent22/joplin/blob/v3.7.18/packages/server/src/routes/api/items.ts)).

Authentication is `POST /api/sessions` with `email`, `password`, numeric platform and application type, and client `version`. The optional `apiKey` field is omitted for compatibility with older self-hosted servers.
The returned `{ id, user_id }` session is sent as `X-API-AUTH` on subsequent
requests. Inventory pages use `GET /api/items/root:/:/children` with an
optional `cursor` query parameter. Item metadata is downloaded and uploaded
through `GET`/`PUT /api/items/root:/<relative-name>:/content`; deletion uses
`DELETE /api/items/root:/<relative-name>:`. The relative name is restricted to
safe slash-separated sync-file segments.

Plaintext item content follows Joplin's BaseItem shape: a title line, a blank
line, an optional note body, a blank line, and `key: value` metadata lines.
Metadata values escape literal backslash sequences before CR/LF. `id` and
`type_` are required; known sync item types are accepted so the service can
gate master-key and revision records without interpreting them as ordinary
notes. Encrypted, malformed, or unsupported representations are rejected by
the codec or service layer.

The implementation uses HTTPS by default. Set `allowInsecureHttp: true` or `JOPLIN_ALLOW_INSECURE_HTTP=true` to use a self-hosted HTTP server on any host. The legacy `allowInsecureLocalhost` option remains limited to loopback addresses. HTTP sends credentials and content without transport encryption; redirects remain disabled for both protocols.
