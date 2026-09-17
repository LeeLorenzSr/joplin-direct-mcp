import fs from 'node:fs';
import path from 'node:path';
import type { ClientConfig } from './contracts.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type ConfigFile = Partial<Record<keyof ClientConfig, unknown>>;

const envName = {
  serverUrl: 'JOPLIN_SERVER_URL',
  email: 'JOPLIN_EMAIL',
  password: 'JOPLIN_PASSWORD',
  stateDir: 'JOPLIN_STATE_DIR',
  readOnly: 'JOPLIN_READ_ONLY',
  allowedNotebookIds: 'JOPLIN_ALLOWED_NOTEBOOK_IDS',
  allowInsecureLocalhost: 'JOPLIN_ALLOW_INSECURE_LOCALHOST',
  allowInsecureHttp: 'JOPLIN_ALLOW_INSECURE_HTTP',
  requestTimeoutMs: 'JOPLIN_REQUEST_TIMEOUT_MS'
} as const;

function fail(message: string): never {
  throw new ConfigError(message);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail('password must be a non-empty string');
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function parseBoolean(value: unknown, field: string, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') fail(`${field} must be a boolean`);
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  fail(`${field} must be true or false`);
}

function parseTimeout(value: unknown): number {
  if (value === undefined) return 30_000;
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value >= 100 && value <= 300_000) return value;
    fail('requestTimeoutMs must be between 100 and 300000 milliseconds');
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    fail('requestTimeoutMs must be an integer');
  }
  const parsed = Number(value);
  if (parsed >= 100 && parsed <= 300_000) return parsed;
  fail('requestTimeoutMs must be between 100 and 300000 milliseconds');
}

function parseAllowedIds(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (value === '') return [];
  const valid = (item: string): boolean => /^[a-f0-9]{32}$/.test(item);
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === 'string' && valid(item.trim()))) {
      fail('allowedNotebookIds must contain only 32-character lowercase hexadecimal IDs');
    }
    return [...new Set(value.map((item) => (item as string).trim()))];
  }
  if (typeof value !== 'string') fail('allowedNotebookIds must be an array of strings');
  const ids = value.split(',').map((item) => item.trim());
  if (ids.some((item) => !valid(item))) fail('allowedNotebookIds must contain only 32-character lowercase hexadecimal IDs');
  return [...new Set(ids)];
}

function validateUrl(serverUrl: string, allowInsecureLocalhost: boolean, allowInsecureHttp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    fail('serverUrl must be an absolute HTTP or HTTPS URL');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) fail('serverUrl must not contain credentials or query parameters');
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (allowInsecureHttp || (loopback && allowInsecureLocalhost)))) {
    fail('serverUrl must use HTTPS unless allowInsecureHttp is enabled (allowInsecureLocalhost permits loopback only)');
  }
  return parsed.toString().replace(/\/$/, '');
}

function readConfigFile(configPath: string): ConfigFile {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    fail(`cannot read config file ${path.basename(configPath)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`config file ${path.basename(configPath)} is not valid JSON`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('config file must contain a JSON object');
  return value as ConfigFile;
}

/** Load user-local JSON configuration, with environment variables taking precedence. */
export function loadConfig(env: Record<string, string | undefined> = process.env, configPath?: string): ClientConfig {
  const file = configPath ? readConfigFile(configPath) : {};
  const value = (field: keyof ClientConfig): unknown => {
    const envKey = envName[field as keyof typeof envName];
    const fromEnv = env[envKey];
    return fromEnv === undefined ? file[field] : fromEnv;
  };

  const allowInsecureLocalhost = parseBoolean(value('allowInsecureLocalhost'), 'allowInsecureLocalhost', false);
  const allowInsecureHttp = parseBoolean(value('allowInsecureHttp'), 'allowInsecureHttp', false);
  const serverUrl = validateUrl(requireString(value('serverUrl'), 'serverUrl'), allowInsecureLocalhost, allowInsecureHttp);
  const email = requireString(value('email'), 'email');
  const password = requireSecret(value('password'));
  const stateDir = requireString(value('stateDir'), 'stateDir');
  return {
    serverUrl,
    email,
    password,
    stateDir,
    allowInsecureLocalhost,
    allowInsecureHttp,
    readOnly: parseBoolean(value('readOnly'), 'readOnly', true),
    allowedNotebookIds: parseAllowedIds(value('allowedNotebookIds')),
    requestTimeoutMs: parseTimeout(value('requestTimeoutMs'))
  };
}
