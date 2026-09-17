#!/usr/bin/env node
import fs from 'node:fs/promises';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';

function usage() {
  return 'node scripts/configure-plugin.mjs --project-dir <installed-project> --config <user-local-config> [--output <plugin/.mcp.json>]';
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!['--project-dir', '--config', '--output'].includes(name)) throw new Error(`unknown argument ${name}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`);
    values[name.slice(2)] = value;
  }
  if (!values['project-dir'] || !values.config) throw new Error(usage());
  return values;
}

const args = parseArgs(process.argv.slice(2));
const projectDir = resolve(args['project-dir']);
const configPath = resolve(args.config);
const output = resolve(args.output ?? join(projectDir, 'plugins', 'joplin-direct-mcp', '.mcp.json'));
const cli = join(projectDir, 'dist', 'cli.js');
try {
  await fs.access(cli);
  await fs.access(configPath);
} catch {
  console.error('project CLI or config path does not exist; build the project and check both paths');
  process.exit(1);
}
const document = {
  mcpServers: {
    'joplin-direct': {
      type: 'stdio',
      command: process.execPath,
      args: [cli, '--config', configPath],
      cwd: projectDir
    }
  }
};
await fs.mkdir(dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`wrote ${output}`);
console.log('Only executable and config paths were copied; credentials remain in the user-local config file.');
