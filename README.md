# @rebasedotdev/mcp

MCP server for [Rebase](https://rebase.dev) — give your coding agent the full
context of every bug report: the reporter's words, AI triage (summary, repro
steps, severity), the pinned DOM element, suspected source locations
(sourcemap-symbolicated), console errors, failed network requests, the session
event trail, and the annotated screenshot.

Rebase doesn't fix your code. Your agent does — this server hands it everything
it needs to start.

## Setup

1. In the Rebase widget on your site, open **Settings → Project → API tokens**
   and create a token (it's shown once — copy it).
2. Add the server to your agent's MCP config:

```json
{
  "mcpServers": {
    "rebase": {
      "command": "npx",
      "args": ["-y", "@rebasedotdev/mcp"],
      "env": {
        "REBASE_API_TOKEN": "rbk_..."
      }
    }
  }
}
```

For Claude Code: `claude mcp add rebase -e REBASE_API_TOKEN=rbk_... -- npx -y @rebasedotdev/mcp`

`REBASE_API_URL` overrides the API origin (defaults to `https://api.rebase.dev`).

## Tools

| Tool | What it does |
| --- | --- |
| `list_tickets` | List bug reports (filter by status, paginate). |
| `get_ticket` | One report with the full capture; `include_screenshot: true` adds the image. |
| `add_comment` | Reply on the ticket thread (visible in the widget). |
| `update_ticket_status` | Move a ticket to `open` / `in-progress` / `resolved`. |

A typical agent loop: `list_tickets` → `get_ticket` → fix the bug with your own
tools → `add_comment` with what changed → `update_ticket_status` to `resolved`.

## Worked example

A session in Claude Code, paraphrased:

> **You:** Triage the newest open bug in Rebase and fix it.

1. The agent calls **`list_tickets`** `{ "status": "open", "limit": 5 }` and gets back
   a lean list — id, title, AI severity, `similarCount`:

   ```json
   {
     "tickets": [
       { "id": "019ebd…", "title": "Checkout button throws TypeError on /cart",
         "status": "open", "severity": "high", "similarCount": 3,
         "createdAt": "2026-06-12T22:13:00Z" }
     ],
     "nextCursor": null
   }
   ```

2. It calls **`get_ticket`** `{ "ticket_id": "019ebd…", "include_screenshot": true }`
   and receives the full capture — the AI triage summary and repro steps, the
   pinned element, the symbolicated **suspected source location**
   (`capture.codeContext.candidates[0]` → `src/components/Cart.tsx:142`), the
   console error, the failed `POST /api/checkout` → 500, plus the screenshot as an
   image block it can actually look at.

3. The agent opens `src/components/Cart.tsx` **with its own editing tools**, fixes
   the bug, and runs your tests. (Rebase never touches your code — it only supplies
   context.)

4. It calls **`add_comment`** `{ "ticket_id": "019ebd…", "body": "Fixed — the cart
   total was undefined before the prices loaded. Patched in CartTotal.tsx." }` so
   the reporter sees the resolution in the widget.

5. It calls **`update_ticket_status`** `{ "ticket_id": "019ebd…", "status":
   "resolved" }`. The pin disappears from the page and watchers are notified.

## Tool reference

- **`list_tickets`** — `{ status?: "open"|"in-progress"|"resolved", limit?: 1–50,
  cursor?: string }`. Returns `{ tickets, nextCursor }`; pass `nextCursor` back as
  `cursor` to page.
- **`get_ticket`** — `{ ticket_id: string, include_screenshot?: boolean }`. Returns
  the full ticket object (`aiTriage`, `capture`, `events`, `comments`,
  `externalIssues`, …). With `include_screenshot`, also returns an image block.
- **`add_comment`** — `{ ticket_id: string, body: string }` (≤ 5000 chars). Posted
  as the user who minted the token; `@Full Name` mentions notify that member.
- **`update_ticket_status`** — `{ ticket_id: string, status:
  "open"|"in-progress"|"resolved" }`.

## Security

- **The token is a credential — treat it like a password.** It grants read of every
  ticket in the project plus comment/resolve. Put it in the MCP client's `env`
  config (or a secret manager), never in source control.
- **Scope it down.** Tokens carry `tickets:read`, `tickets:write`, and
  `comments:write` by default; mint a read-only token (`tickets:read`) for an agent
  that should only observe.
- **Rotate / revoke** any time from the widget (Settings → Project → API tokens).
  Revoking takes effect immediately; tokens also auto-expire (default 365 days).
- **Transport is local stdio** — the server runs as a child process of your agent
  and opens no network listener. Its only outbound calls are to your Rebase API
  (`REBASE_API_URL`) over HTTPS.
- **No secrets are logged.** The server writes nothing to stdout except the MCP
  protocol itself, and error messages carry only HTTP status + the API's own text.

## Production notes

- Requires **Node ≥ 18** (uses the global `fetch` and `AbortSignal.timeout`).
- Every API call has a **20s timeout**; screenshot downloads are capped at **10 MB**
  — a slow or oversized response fails the tool rather than hanging the agent.
- Runtime dependencies are only `@modelcontextprotocol/sdk` and `zod` (both audited
  clean). Server-side, the `/v1` API enforces per-token rate limits (120 reads/min,
  30 writes/min) and returns `404` for any ticket outside the token's project.

## Troubleshooting

- **`Rebase API 401`** — the token is missing, mistyped, revoked, or expired. Mint a
  fresh one in the widget. (401s are deliberately indistinguishable — the API never
  reveals which.)
- **`Rebase API 403: This token lacks the … scope`** — the action needs a scope the
  token wasn't given (e.g. a read-only token trying to resolve). Re-mint with the
  scope.
- **`Rebase API 402`** — the project's Rebase subscription is inactive; commenting is
  paused until billing is restored.
- **`Rebase API 404` on a ticket you can see** — that ticket belongs to a different
  project than the token. One token = one project.
- **`Rebase API request timed out`** — the API didn't respond within 20s; retry.
- **Self-hosting / staging** — point the server at another API origin with
  `REBASE_API_URL` (e.g. `https://api.staging.rebase.dev`).

## Development

```bash
npm install
npm test     # vitest — exercises the tools over a real in-memory MCP transport
```
