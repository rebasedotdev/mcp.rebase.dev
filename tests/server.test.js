import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { RebaseApi } from '../src/api.js';
import { buildServer } from '../src/server.js';

/** A fetch fake that dispatches on URL + method. */
function fakeFetch(routes) {
  return vi.fn(async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const key = `${method} ${String(url)}`;
    const match = Object.entries(routes).find(([pattern]) => key.includes(pattern));
    if (!match) throw new Error(`Unexpected request: ${key}`);
    const [, handler] = match;
    return typeof handler === 'function' ? handler(url, init) : handler;
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function api(routes) {
  return new RebaseApi({ token: 'rbk_test', baseUrl: 'https://api.test', fetchImpl: fakeFetch(routes) });
}

/** Call a tool through a real MCP client over an in-memory transport. */
async function callTool(server, name, args) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

describe('RebaseApi', () => {
  it('requires a token', () => {
    expect(() => new RebaseApi({ token: '' })).toThrow(/REBASE_API_TOKEN/);
  });

  it('sends the bearer header and parses JSON', async () => {
    const fetchImpl = fakeFetch({ 'GET https://api.test/v1/tickets': jsonResponse({ tickets: [] }) });
    const client = new RebaseApi({ token: 'rbk_test', baseUrl: 'https://api.test/', fetchImpl });

    const data = await client.listTickets();

    expect(data).toEqual({ tickets: [] });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer rbk_test');
  });

  it('surfaces API errors with status and message', async () => {
    const client = api({ '/v1/tickets': jsonResponse({ error: { message: 'missing scope' } }, 403) });

    await expect(client.listTickets()).rejects.toThrow(/403.*missing scope/);
  });

  it('passes an abort signal so requests time out', async () => {
    const fetchImpl = fakeFetch({ '/v1/tickets': jsonResponse({ tickets: [] }) });
    const client = new RebaseApi({ token: 'rbk_test', baseUrl: 'https://api.test', fetchImpl, timeoutMs: 5000 });

    await client.listTickets();

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces a timeout as a readable error', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    });
    const client = new RebaseApi({ token: 'rbk_test', baseUrl: 'https://api.test', fetchImpl });

    await expect(client.listTickets()).rejects.toThrow(/timed out/);
  });

  it('rejects an oversized screenshot by declared content-length', async () => {
    const huge = new Response('x', { headers: { 'content-length': String(50 * 1024 * 1024) } });
    const client = api({ 'GET https://cdn.test/big.png': huge });

    expect(await client.fetchScreenshotBase64('https://cdn.test/big.png')).toBeNull();
  });
});

describe('tools', () => {
  it('list_tickets passes filters through and returns JSON text', async () => {
    const fetchImpl = fakeFetch({ '/v1/tickets': jsonResponse({ tickets: [{ id: 't1' }], nextCursor: null }) });
    const client = new RebaseApi({ token: 'rbk_test', baseUrl: 'https://api.test', fetchImpl });
    const server = buildServer(client);

    const result = await callTool(server, 'list_tickets', { status: 'open', limit: 10 });

    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('status=open');
    expect(String(url)).toContain('limit=10');
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text).tickets[0].id).toBe('t1');
  });

  it('get_ticket returns the capture and an image block when asked', async () => {
    const png = Buffer.from('png-bytes');
    const client = api({
      '/v1/tickets/t1': jsonResponse({ id: 't1', screenshotUrl: 'https://cdn.test/shot.png' }),
      'GET https://cdn.test/shot.png': new Response(png),
    });
    const server = buildServer(client);

    const result = await callTool(server, 'get_ticket', { ticket_id: 't1', include_screenshot: true });

    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from(result.content[1].data, 'base64').toString()).toBe('png-bytes');
  });

  it('get_ticket omits the image when the screenshot fetch fails', async () => {
    const client = api({
      '/v1/tickets/t1': jsonResponse({ id: 't1', screenshotUrl: 'https://cdn.test/shot.png' }),
      'GET https://cdn.test/shot.png': new Response('', { status: 404 }),
    });
    const server = buildServer(client);

    const result = await callTool(server, 'get_ticket', { ticket_id: 't1', include_screenshot: true });

    expect(result.content).toHaveLength(1);
  });

  it('add_comment posts the body', async () => {
    const fetchImpl = fakeFetch({
      'POST https://api.test/v1/tickets/t1/comments': jsonResponse({ id: 'c1', body: 'On it.' }, 201),
    });
    const client = new RebaseApi({ token: 'rbk_test', baseUrl: 'https://api.test', fetchImpl });
    const server = buildServer(client);

    const result = await callTool(server, 'add_comment', { ticket_id: 't1', body: 'On it.' });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ body: 'On it.' });
    expect(JSON.parse(result.content[0].text).id).toBe('c1');
  });

  it('update_ticket_status patches the status', async () => {
    const fetchImpl = fakeFetch({
      'PATCH https://api.test/v1/tickets/t1': jsonResponse({ id: 't1', status: 'resolved' }),
    });
    const client = new RebaseApi({ token: 'rbk_test', baseUrl: 'https://api.test', fetchImpl });
    const server = buildServer(client);

    const result = await callTool(server, 'update_ticket_status', { ticket_id: 't1', status: 'resolved' });

    expect(JSON.parse(result.content[0].text).status).toBe('resolved');
  });
});
