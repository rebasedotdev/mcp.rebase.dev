/**
 * Thin client for Rebase's /v1 agent API. Auth is a personal `rbk_*`
 * token (minted in app.rebase.dev → your account → Your coding agent) sent as a Bearer
 * header. Kept dependency-free: plain fetch, JSON in/out.
 */

/** Default per-request timeout (ms). A hung API call must not hang the agent. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Hard cap on a downloaded screenshot (bytes) so a huge asset can't OOM. */
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

export class RebaseApi {
  /**
   * @param {{ token: string, baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
   */
  constructor({ token, baseUrl = 'https://api.rebase.dev', fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!token) {
      throw new Error('REBASE_API_TOKEN is required (mint one in app.rebase.dev → your account → Your coding agent).');
    }
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(`REBASE_API_URL is not a valid URL: ${JSON.stringify(baseUrl)}`);
    }
    // The token rides every request as a Bearer header — never let it travel
    // over cleartext to a non-local host.
    const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
      throw new Error('REBASE_API_URL must use https:// (plain http is allowed only for localhost).');
    }
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ query?: Record<string, string | number | null | undefined>, body?: unknown }} [options]
   */
  async request(method, path, { query, body } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }

    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // AbortSignal.timeout rejects with a TimeoutError; surface it readably.
      if (err?.name === 'TimeoutError') {
        throw new Error(`Rebase API request timed out after ${String(this.timeoutMs)}ms.`);
      }
      // undici buries the real reason (ENOTFOUND, ECONNREFUSED, TLS) in cause.
      const cause = err?.cause?.message ? ` (${err.cause.message})` : '';
      throw new Error(`Rebase API request failed: ${err?.message ?? String(err)}${cause}`);
    }

    if (!response.ok) {
      let detail = '';
      try {
        const json = await response.json();
        detail = json?.error?.message ?? json?.message ?? '';
      } catch {
        // non-JSON error body — the status alone will have to do
      }
      // Relay the throttle's wait hint; Retry-After may legally be an
      // HTTP-date, so only pass through plain seconds.
      const retryAfter = response.status === 429 ? response.headers.get('retry-after') : null;
      const retry = retryAfter && /^\d+$/.test(retryAfter.trim()) ? ` (retry after ${retryAfter.trim()}s)` : '';
      throw new Error(`Rebase API ${String(response.status)}${detail ? `: ${detail}` : ''}${retry}`);
    }

    return response.json();
  }

  listProjects() {
    return this.request('GET', '/v1/projects');
  }

  /** @param {{ project?: string, status?: string, limit?: number, cursor?: string | null }} [params] */
  listTickets(params = {}) {
    return this.request('GET', '/v1/tickets', { query: params });
  }

  /** @param {{ q: string, project?: string, status?: string, limit?: number }} params */
  searchTickets(params) {
    return this.request('GET', '/v1/tickets/search', { query: params });
  }

  /** @param {string} ticketId */
  getTicket(ticketId) {
    return this.request('GET', `/v1/tickets/${encodeURIComponent(ticketId)}`);
  }

  /** @param {string} ticketId */
  getInvestigationBundle(ticketId) {
    return this.request('GET', `/v1/tickets/${encodeURIComponent(ticketId)}/investigation-bundle`);
  }

  fetchTicketScreenshot(ticketId) {
    return this.fetchScreenshotBase64(`${this.baseUrl}/v1/tickets/${encodeURIComponent(ticketId)}/screenshot`, true);
  }

  /**
   * Read bounded PNG bytes from the configured API origin. Production callers
   * construct the authenticated ticket route; returned provider/storage URLs
   * are never fetched. Redirects, foreign origins and non-PNG responses fail closed.
   *
   * @param {string} url
   * @returns {Promise<string | null>}
   */
  async fetchScreenshotBase64(url, authenticated = false) {
    let timer;
    try {
      // Allow HTTP only for the exact configured loopback API origin.
      // Production uses a constructed authenticated route and rejects redirects.
      const parsed = new URL(url);
      const base = new URL(this.baseUrl);
      const localApi = base.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) &&
        parsed.origin === base.origin;
      if (parsed.username || parsed.password || parsed.origin !== base.origin ||
        (parsed.protocol !== 'https:' && !localApi)) return null;


      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const signal = controller.signal;
      const response = await this.fetch(url, { signal, redirect: 'error',
        ...(authenticated ? { headers: { Authorization: `Bearer ${this.token}`, Accept: 'image/png' } } : {}),
      });
      if (!response.ok) return null;

      // Reject oversized assets up-front when the server declares a length.
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_SCREENSHOT_BYTES || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/png' || !response.body) {
        controller.abort();
        await response.body?.cancel();
        return null;
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_SCREENSHOT_BYTES) {
            controller.abort();
            await reader.cancel();
            return null;
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      const buffer = Buffer.concat(chunks, size);
      if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
      return buffer.toString('base64');
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
