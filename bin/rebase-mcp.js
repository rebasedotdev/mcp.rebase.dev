#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { RebaseApi } from '../src/api.js';
import { buildServer } from '../src/server.js';

try {
  const api = new RebaseApi({
    token: process.env.REBASE_API_TOKEN ?? '',
    baseUrl: process.env.REBASE_API_URL ?? 'https://api.rebase.dev',
  });

  await buildServer(api).connect(new StdioServerTransport());
} catch (err) {
  // stderr only — stdout carries the MCP protocol.
  console.error(`rebase-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
