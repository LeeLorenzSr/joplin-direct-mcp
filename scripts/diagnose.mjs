#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

const configPath = process.argv[2] ?? process.env.JOPLIN_MCP_CONFIG ?? process.env.JOPLIN_CONFIG_PATH;
let config = {};
if (configPath) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    console.error('config: unreadable or invalid JSON');
    process.exitCode = 1;
  }
}
const value = (envName, fileName) => process.env[envName] ?? config[fileName];
const url = value('JOPLIN_SERVER_URL', 'serverUrl');
let urlState = 'missing';
try {
  const parsed = new URL(url);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.replace(/^\[|\]$/g, ''));
  const enabled = setting => ['true', '1', 'yes'].includes(String(setting).trim().toLowerCase());
  const httpAllowed = enabled(value('JOPLIN_ALLOW_INSECURE_HTTP', 'allowInsecureHttp')) || (loopback && enabled(value('JOPLIN_ALLOW_INSECURE_LOCALHOST', 'allowInsecureLocalhost')));
  urlState = !parsed.username && !parsed.password && !parsed.search && !parsed.hash && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && httpAllowed)) ? 'valid' : 'requires HTTPS or explicitly enabled HTTP, without URL credentials or query parameters';
} catch { if (url) urlState = 'invalid'; }
console.log(`server URL: ${urlState}`);
console.log(`email: ${value('JOPLIN_EMAIL', 'email') ? 'configured' : 'missing'}`);
console.log(`password: ${value('JOPLIN_PASSWORD', 'password') ? 'configured' : 'missing'}`);
console.log(`state directory: ${value('JOPLIN_STATE_DIR', 'stateDir') ? 'configured' : 'missing'}`);
console.log('secrets: values omitted');
