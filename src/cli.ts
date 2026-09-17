#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { JoplinClient } from './client.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp.js';
import { JoplinServerTransport } from './transport.js';

export interface CliArgs { configPath: string | undefined; help: boolean; }

export function parseCliArgs(argv: string[]): CliArgs {
  let configPath: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--config') {
      const next = argv[index + 1];
      if (!next || next.startsWith('-')) throw new Error('--config requires a path');
      configPath = next; index += 1; continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  return { configPath, help };
}

export function helpText(): string {
  return 'joplin-direct-mcp --config <path>\n\nConfiguration may also be provided with JOPLIN_* environment variables. MCP uses stdio; keep stdout reserved for protocol messages.';
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseCliArgs(argv);
  if (args.help) { process.stderr.write(`${helpText()}\n`); return; }
  const configPath = args.configPath ?? process.env.JOPLIN_CONFIG_PATH ?? process.env.JOPLIN_MCP_CONFIG;
  const config = loadConfig(process.env, configPath);
  const transport = new JoplinServerTransport(config);
  const client = new JoplinClient(config, transport);
  const server = createMcpServer(client);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([server.close(), client.close()]);
  };
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
  const stdio = new StdioServerTransport();
  process.stdin.once('end', () => { void close(); });
  try {
    await server.connect(stdio);
  } catch (error) {
    await close();
    throw error;
  }
  server.server.onclose = () => { void close(); };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'startup failed'}\n`); process.exitCode = 1; });
}
