/**
 * Thin client for Rebase's /v1 agent API. Auth is a project-scoped `rbk_*`
 * token (minted in widget Settings → Project → API tokens) sent as a Bearer
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
      throw new Error('REBASE_API_TOKEN is required (mint one in widget Settings → Project → API tokens).');
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

  /** @param {{ status?: string, limit?: number, cursor?: string | null }} [params] */
  listTickets(params = {}) {
    return this.request('GET', '/v1/tickets', { query: params });
  }

  /** @param {{ q: string, status?: string, limit?: number }} params */
  searchTickets(params) {
    return this.request('GET', '/v1/tickets/search', { query: params });
  }

  /** @param {string} ticketId */
  getTicket(ticketId) {
    return this.request('GET', `/v1/tickets/${encodeURIComponent(ticketId)}`);
  }

  /** @param {string} ticketId */
  getFixBundle(ticketId) {
    return this.request('GET', `/v1/tickets/${encodeURIComponent(ticketId)}/fix-bundle`);
  }

  /**
   * @param {string} ticketId
   * @param {string} body
   * @param {string|undefined} agentLabel  display provenance ("via Claude Code")
   */
  addComment(ticketId, body, agentLabel) {
    const payload = agentLabel ? { body, agentLabel } : { body };
    return this.request('POST', `/v1/tickets/${encodeURIComponent(ticketId)}/comments`, { body: payload });
  }

  /**
   * @param {string} ticketId
   * @param {string} status
   */
  updateStatus(ticketId, status) {
    return this.request('PATCH', `/v1/tickets/${encodeURIComponent(ticketId)}`, { body: { status } });
  }

  /**
   * Link a PR to a ticket you're fixing. Returns the `prMarker` to embed in the
   * PR body so the CI repro check can discover and verify it.
   *
   * @param {string} ticketId
   * @param {{ pr_number: number, repo: string, branch?: string }} args
   */
  claimFix(ticketId, { pr_number: prNumber, repo, branch }) {
    return this.request('POST', `/v1/tickets/${encodeURIComponent(ticketId)}/claim`, {
      body: { prNumber, repoFullName: repo, ...(branch ? { branch } : {}) },
    });
  }

  /**
   * The current CI verification verdict for a ticket (poll after pushing).
   *
   * @param {string} ticketId
   */
  verificationStatus(ticketId) {
    return this.request('GET', `/v1/tickets/${encodeURIComponent(ticketId)}/verification`);
  }

  /**
   * Download the short-lived signed screenshot URL and return base64 PNG bytes,
   * or null when the URL isn't https / the fetch fails / times out / exceeds
   * the size cap (the signed URL may have just expired, or the asset may be
   * unexpectedly large).
   *
   * @param {string} url
   * @returns {Promise<string | null>}
   */
  async fetchScreenshotBase64(url) {
    try {
      // The URL comes from the API response body — only follow it over https,
      // and treat any redirect as anomalous (signed storage URLs never
      // redirect; following one could reach an attacker-chosen origin).
      if (new URL(url).protocol !== 'https:') return null;

      const response = await this.fetch(url, { signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
      if (!response.ok) return null;

      // Reject oversized assets up-front when the server declares a length.
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_SCREENSHOT_BYTES) return null;

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_SCREENSHOT_BYTES) return null; // length lied / was absent

      return Buffer.from(buffer).toString('base64');
    } catch {
      return null;
    }
  }
}
