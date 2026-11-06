#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { loadConfig } from './config.js';
import { createEvolutionClient } from './evolution.js';
import { createServer } from './server.js';

async function main() {
  const config = loadConfig();
  const client = createEvolutionClient({ baseUrl: config.url, apiKey: config.apiKey, timeoutMs: config.timeoutMs });
  const server = createServer(client, config);
  await server.connect(new StdioServerTransport());
  // stdout é o canal do protocolo: log só no stderr.
  console.error(`evolution-mcp conectado a ${config.url} (modo ${config.mode})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
