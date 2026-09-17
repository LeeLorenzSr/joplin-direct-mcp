#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import process from 'node:process';

const projectDir = process.env.JOPLIN_MCP_PROJECT_DIR;
if (!projectDir) {
  console.error('JOPLIN_MCP_PROJECT_DIR must point to the installed joplin-mcp-client project');
  process.exit(2);
}
const cli = join(resolve(projectDir), 'dist', 'cli.js');
const config = process.env.JOPLIN_MCP_CONFIG;
const args = [cli];
if (config) args.push('--config', resolve(config));
const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
child.on('error', (error) => { console.error(`could not start Joplin MCP client: ${error.message}`); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
