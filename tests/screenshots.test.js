import { describe, expect, it, vi } from 'vitest';
import { RebaseApi } from '../src/api.js';

const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const headers = { 'content-type': 'image/png' };
describe('bounded authenticated screenshots', () => {
  it('never requests foreign origins, credential URLs, or internal HTTPS hosts', async () => {
    const fetchImpl = vi.fn();
    const api = new RebaseApi({ token: 'private', fetchImpl });
    for (const url of ['https://127.0.0.1/private', 'https://api.rebase.dev.attacker.test/a', 'https://user:pass@api.rebase.dev/a', 'https://cdn.test/a', 'http://api.rebase.dev/a']) {
      expect(await api.fetchScreenshotBase64(url)).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses only the constructed API route and rejects redirects', async () => {
    const fetchImpl = vi.fn(async () => new Response(signature, { headers }));
    const api = new RebaseApi({ token: 'private', fetchImpl });
    expect(await api.fetchTicketScreenshot('a/b')).toBe(Buffer.from(signature).toString('base64'));
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.rebase.dev/v1/tickets/a%2Fb/screenshot');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer private' } });
  });

  it('cancels an oversized unknown-length stream before reading its remainder', async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel,
    }, { highWaterMark: 0 });
    const api = new RebaseApi({ token: 'private', fetchImpl: async () => new Response(body, { headers }) });
    expect(await api.fetchTicketScreenshot('one')).toBeNull();
    expect(pulls).toBe(11);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects declared oversized bodies before reading and rejects non-PNG data', async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    const api = new RebaseApi({ token: 'private', fetchImpl: async () => new Response(body, { headers: { ...headers, 'content-length': String(11 * 1024 * 1024) } }) });
    expect(await api.fetchTicketScreenshot('one')).toBeNull();
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    for (const response of [new Response('<svg/>', { headers }), new Response(signature, { headers: { 'content-type': 'text/plain' } }), new Response(signature.slice(0, 7), { headers })]) {
      api.fetch = async () => response;
      expect(await api.fetchTicketScreenshot('one')).toBeNull();
    }
  });

  it('validates a PNG signature split across chunks and handles read errors', async () => {
    const body = new ReadableStream({ start(c) { c.enqueue(signature.slice(0, 3)); c.enqueue(signature.slice(3)); c.close(); } });
    const api = new RebaseApi({ token: 'private', fetchImpl: async () => new Response(body, { headers }) });
    expect(await api.fetchTicketScreenshot('one')).toBe(Buffer.from(signature).toString('base64'));
    api.fetch = async () => new Response(new ReadableStream({ start(c) { c.error(new Error('connection lost')); } }), { headers });
    expect(await api.fetchTicketScreenshot('one')).toBeNull();
  });
  it('accepts the exact byte limit and aborts a stalled download at the deadline', async () => {
    const bytes = new Uint8Array(10 * 1024 * 1024); bytes.set(signature);
    const api = new RebaseApi({token:'private',fetchImpl:async()=>new Response(bytes,{headers})});
    expect(Buffer.from(await api.fetchTicketScreenshot('one'),'base64').length).toBe(bytes.length);
    vi.useFakeTimers();
    try {
      const stalled = new RebaseApi({token:'private',timeoutMs:20,fetchImpl:(_url,{signal}) => new Promise((_resolve,reject) => signal.addEventListener('abort',()=>reject(new Error('aborted'))))});
      const reading = stalled.fetchTicketScreenshot('one');
      await vi.advanceTimersByTimeAsync(21);
      expect(await reading).toBeNull();
    } finally { vi.useRealTimers(); }
  });

});
