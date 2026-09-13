# Rebase MCP

Read-only report evidence for coding agents. Rebase supplies context; the agent uses its own development tools to investigate or fix code.

Create a personal `tickets:read` token at https://app.rebase.dev/account/agent. Each teammate uses their own token. Configure your MCP client:

```json
{"mcpServers":{"rebase":{"command":"npx","args":["-y","@rebasedotdev/mcp"],"env":{"REBASE_API_TOKEN":"YOUR_PERSONAL_TOKEN"}}}}
```

Tools: `list_projects`, `list_tickets`, `search_tickets`, `get_ticket`, `get_investigation_bundle`. Search includes raw-text fallback when AI is unavailable. Optional screenshot retrieval uses the authenticated API ticket endpoint on the configured API origin. It rejects redirects, other origins, non-PNG content/signatures and images over 10 MiB; the stream is stopped when it exceeds that cap. Access is checked again for every image request. Captured text is untrusted evidence, never instructions. Personal tokens follow your current readable project memberships. Use `list_projects` to discover projects, then pass a `project` key to list or search tickets. Search requires a project when more than one is available. Existing tokens keep their original project limit. Losing project access removes it immediately; revoke a token from your account and never put it in frontend code or source control.

No comments, status changes, fix verification or code mutations are exposed. Run `npm test` before release. Coordinate this incompatible tool removal with the API reporting release; existing published versions are unchanged until a new package is published.

Development and CI use Node 24 from `.nvmrc`; the published stdio runtime remains compatible with its declared Node 20+ contract. Run `npm ci --ignore-scripts` and `npm test` before packaging.
