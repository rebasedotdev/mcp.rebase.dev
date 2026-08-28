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

  it('rejects a base URL that is not https (except localhost)', () => {
    expect(() => new RebaseApi({ token: 'rbk_test', baseUrl: 'http://api.rebase.dev' })).toThrow(/https/);
    expect(() => new RebaseApi({ token: 'rbk_test', baseUrl: 'not a url' })).toThrow(/valid URL/);
    expect(() => new RebaseApi({ token: 'rbk_test', baseUrl: 'http://localhost:8787' })).not.toThrow();
    expect(() => new RebaseApi({ token: 'rbk_test', baseUrl: 'http://127.0.0.1:3000' })).not.toThrow();
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

  it('appends the Retry-After hint to 429 errors', async () => {
    const throttled = new Response(JSON.stringify({ error: { message: 'Too many requests.' } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '17' },
    });
    const client = api({ '/v1/tickets': throttled });

    await expect(client.listTickets()).rejects.toThrow(/429.*retry after 17s/);
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

  it('refuses to fetch a non-https screenshot URL', async () => {
    const fetchImpl = fakeFetch({});
    const client = new RebaseApi({ token: 'rbk_test', baseUrl: 'https://api.test', fetchImpl });

    expect(await client.fetchScreenshotBase64('http://169.254.169.254/latest/meta-data')).toBeNull();
    expect(await client.fetchScreenshotBase64('not a url')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it('search_tickets passes the query through and returns scored results', async () => {
    const fetchImpl = fakeFetch({
      '/v1/tickets/search': jsonResponse({
        results: [{ id: 't1', title: 'Checkout total wrong', status: 'open', kind: 'bug', score: 0.91 }],
      }),
    });
    const client = new RebaseApi({ token: 'rbk_test', baseUrl: 'https://api.test', fetchImpl });
    const server = buildServer(client);

    const result = await callTool(server, 'search_tickets', { q: 'checkout total', status: 'open', limit: 5 });

    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v1/tickets/search');
    expect(String(url)).toContain('q=checkout+total');
    expect(String(url)).toContain('status=open');
    expect(String(url)).toContain('limit=5');
    expect(JSON.parse(result.content[0].text).results[0].score).toBe(0.91);
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

  it('get_ticket returns a note instead of the image when the screenshot fetch fails', async () => {
    const client = api({
      '/v1/tickets/t1': jsonResponse({ id: 't1', screenshotUrl: 'https://cdn.test/shot.png' }),
      'GET https://cdn.test/shot.png': new Response('', { status: 404 }),
    });
    const server = buildServer(client);

    const result = await callTool(server, 'get_ticket', { ticket_id: 't1', include_screenshot: true });

    expect(result.content).toHaveLength(2);
    expect(result.content[1].type).toBe('text');
    expect(result.content[1].text).toMatch(/unavailable/i);
  });

  it('get_ticket notes when no screenshot exists at all', async () => {
    const client = api({ '/v1/tickets/t1': jsonResponse({ id: 't1' }) });
    const server = buildServer(client);

    const result = await callTool(server, 'get_ticket', { ticket_id: 't1', include_screenshot: true });

    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toMatchObject({ type: 'text' });
    expect(result.content[1].text).toMatch(/unavailable/i);
  });

  it('a failing API call surfaces as an isError result, not a crash', async () => {
    const client = api({ '/v1/tickets': jsonResponse({ error: { message: 'This token lacks the tickets:read scope.' } }, 403) });
    const server = buildServer(client);

    const result = await callTool(server, 'list_tickets', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/403.*tickets:read/);
  });

  it('list_tickets accepts cursor: null and omits it from the query', async () => {
    const fetchImpl = fakeFetch({ '/v1/tickets': jsonResponse({ tickets: [], nextCursor: null }) });
    const client = new RebaseApi({ token: 'rbk_test', baseUrl: 'https://api.test', fetchImpl });
    const server = buildServer(client);

    const result = await callTool(server, 'list_tickets', { cursor: null });

    expect(result.isError).not.toBe(true);
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain('cursor=');
  });

  it('get_fix_bundle returns the bundle and an image block when asked', async () => {
    const png = Buffer.from('png-bytes');
    const client = api({
      '/v1/tickets/t1/fix-bundle': jsonResponse({
        ticketId: 't1',
        title: 'Checkout button throws TypeError on /cart',
        url: 'https://shop.test/cart?rebase_ticket=t1',
        summary: 'Cart total is read before prices load.',
        reproSteps: ['Open /cart with an empty cache', 'Click checkout'],
        failingTest: { spec: "test('checkout', …)" },
        likelySource: [{ file: 'src/Cart.tsx', line: 142, permalink: 'https://github.com/x/y/blob/abc/src/Cart.tsx#L142', confidence: 'high' }],
        screenshotUrl: 'https://cdn.test/shot.png',
      }),
      'GET https://cdn.test/shot.png': new Response(png),
    });
    const server = buildServer(client);

    const result = await callTool(server, 'get_fix_bundle', { ticket_id: 't1', include_screenshot: true });

    const bundle = JSON.parse(result.content[0].text);
    expect(bundle.likelySource[0].line).toBe(142);
    expect(bundle.failingTest.spec).toContain('checkout');
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });

  it('get_fix_bundle surfaces a 404 as an isError result', async () => {
    const client = api({
      '/v1/tickets/missing/fix-bundle': jsonResponse({ error: { code: 'not_found', message: 'Resource not found.' } }, 404),
    });
    const server = buildServer(client);

    const result = await callTool(server, 'get_fix_bundle', { ticket_id: 'missing' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/404.*not found/i);
  });

  it('add_comment posts the body', async () => {
    const fetchImpl = fakeFetch({
      'POST https://api.test/v1/tickets/t1/comments': jsonResponse({ id: 'c1', body: 'On it.' }, 201),
    });
    const client = new RebaseApi({ token: 'rbk_test', baseUrl: 'https://api.test', fetchImpl });
    const server = buildServer(client);

    const result = await callTool(server, 'add_comment', { ticket_id: 't1', body: 'On it.' });

    const [, init] = fetchImpl.mock.calls[0];
    // The MCP client always identifies itself, so a label rides along.
    expect(JSON.parse(init.body).body).toBe('On it.');
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

  it('update_ticket_status passes through the held-for-verification response', async () => {
    const fetchImpl = fakeFetch({
      'PATCH https://api.test/v1/tickets/t1': jsonResponse({
        id: 't1',
        status: 'in-progress',
        requestedStatus: 'resolved',
        heldForVerification: true,
        hint: 'Run the Rebase repro-check action in CI; a green run resolves this ticket.',
      }),
    });
    const server = buildServer(new RebaseApi({ token: 'rbk_test', baseUrl: 'https://api.test', fetchImpl }));

    const result = await callTool(server, 'update_ticket_status', { ticket_id: 't1', status: 'resolved' });
    const body = JSON.parse(result.content[0].text);
    expect(body.heldForVerification).toBe(true);
    expect(body.status).toBe('in-progress');
  });

  it('claim_fix links the PR and returns the marker', async () => {
    const fetchImpl = fakeFetch({
      'POST https://api.test/v1/tickets/t1/claim': jsonResponse({
        ticketId: 't1',
        claimed: true,
        prMarker: 'Rebase-Ticket: t1',
      }),
    });
    const server = buildServer(new RebaseApi({ token: 'rbk_test', baseUrl: 'https://api.test', fetchImpl }));

    const result = await callTool(server, 'claim_fix', { ticket_id: 't1', pr_number: 87, repo: 'acme/shop' });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ prNumber: 87, repoFullName: 'acme/shop' });
    expect(JSON.parse(result.content[0].text).prMarker).toBe('Rebase-Ticket: t1');
  });

  it('get_verification_status returns the verdict', async () => {
    const fetchImpl = fakeFetch({
      'GET https://api.test/v1/tickets/t1/verification': jsonResponse({
        ticketId: 't1',
        state: 'verified',
        conclusion: 'success',
      }),
    });
    const server = buildServer(new RebaseApi({ token: 'rbk_test', baseUrl: 'https://api.test', fetchImpl }));

    const result = await callTool(server, 'get_verification_status', { ticket_id: 't1' });
    expect(JSON.parse(result.content[0].text).state).toBe('verified');
  });

  it('add_comment forwards the client name as the agent label', async () => {
    const fetchImpl = fakeFetch({
      'POST https://api.test/v1/tickets/t1/comments': jsonResponse({ id: 'c1', body: 'Fixed.' }, 201),
    });
    const server = buildServer(new RebaseApi({ token: 'rbk_test', baseUrl: 'https://api.test', fetchImpl }));

    await callTool(server, 'add_comment', { ticket_id: 't1', body: 'Fixed.' });

    const [, init] = fetchImpl.mock.calls[0];
    // The in-memory test client identifies as "test-client".
    expect(JSON.parse(init.body).agentLabel).toBe('test-client');
  });
});
