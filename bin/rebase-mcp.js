#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { RebaseApi } from '../src/api.js';
import { buildServer } from '../src/server.js';

const api = new RebaseApi({
  token: process.env.REBASE_API_TOKEN ?? '',
  baseUrl: process.env.REBASE_API_URL ?? 'https://api.rebase.dev',
});

const server = buildServer(api);

await server.connect(new StdioServerTransport());
