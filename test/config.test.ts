import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, ConfigError } from '../src/config.js';

const base = {
  JOPLIN_SERVER_URL: 'https://joplin.example.test/',
  JOPLIN_EMAIL: 'agent@example.test',
  JOPLIN_PASSWORD: 'secret-value',
  JOPLIN_STATE_DIR: './state'
};

test('loads defaults and environment overrides without changing the secret', () => {
  const config = loadConfig({ ...base, JOPLIN_READ_ONLY: 'false', JOPLIN_ALLOWED_NOTEBOOK_IDS: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', JOPLIN_REQUEST_TIMEOUT_MS: '5000' });
  assert.equal(config.serverUrl, 'https://joplin.example.test');
  assert.equal(config.readOnly, false);
  assert.deepEqual(config.allowedNotebookIds, ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
  assert.equal(config.requestTimeoutMs, 5000);
  assert.equal(config.password, 'secret-value');
});

test('requires HTTPS except explicitly opted-in loopback HTTP', () => {
  assert.throws(() => loadConfig({ ...base, JOPLIN_SERVER_URL: 'http://joplin.example.test' }), ConfigError);
  const config = loadConfig({ ...base, JOPLIN_SERVER_URL: 'http://127.0.0.1:41184/', JOPLIN_ALLOW_INSECURE_LOCALHOST: 'true' });
  assert.equal(config.serverUrl, 'http://127.0.0.1:41184');
});

test('rejects malformed booleans, timeouts and missing credentials', () => {
  assert.throws(() => loadConfig({ ...base, JOPLIN_READ_ONLY: 'sometimes' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, JOPLIN_REQUEST_TIMEOUT_MS: '0' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, JOPLIN_PASSWORD: undefined }), ConfigError);
});

test('remote HTTP requires the general opt-in and preserves host, port and subpath', () => {
  const env = { ...base, JOPLIN_SERVER_URL: 'http://joplin.example.test:22300/joplin/' };
  assert.throws(() => loadConfig({ ...env, JOPLIN_ALLOW_INSECURE_LOCALHOST: 'true' }), ConfigError);
  assert.equal(loadConfig({ ...env, JOPLIN_ALLOW_INSECURE_HTTP: 'true' }).serverUrl, 'http://joplin.example.test:22300/joplin');
  assert.throws(() => loadConfig({ ...env, JOPLIN_ALLOW_INSECURE_HTTP: 'false' }), ConfigError);
  assert.throws(() => loadConfig({ ...env, JOPLIN_ALLOW_INSECURE_HTTP: 'sometimes' }), ConfigError);
  assert.throws(() => loadConfig({ ...env, JOPLIN_SERVER_URL: 'ftp://joplin.example.test', JOPLIN_ALLOW_INSECURE_HTTP: 'true' }), ConfigError);
});
