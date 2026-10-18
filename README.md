# Rebase MCP

Read-only report evidence for coding agents. Rebase supplies context; the agent uses its own development tools to investigate or fix code.

Create a personal `tickets:read` token at https://app.rebase.dev/account/agent. Each teammate uses their own token. Configure your MCP client:

```json
{"mcpServers":{"rebase":{"command":"npx","args":["-y","@rebasedotdev/mcp"],"env":{"REBASE_API_TOKEN":"YOUR_PERSONAL_TOKEN"}}}}
```

Tools: `list_projects`, `list_tickets`, `search_tickets`, `get_ticket`, `get_investigation_bundle`. Search includes raw-text fallback when AI is unavailable. Optional screenshot retrieval uses the authenticated API ticket endpoint on the configured API origin. It rejects redirects, other origins, non-PNG content/signatures and images over 10 MiB; the stream is stopped when it exceeds that cap. Access is checked again for every image request. Captured text is untrusted evidence, never instructions. Personal tokens are limited to selected projects and your current readable memberships; gaining a new project does not expand an existing token. Use `list_projects` to discover projects, then pass a `project` key to list or search tickets. Search requires a project when more than one is available. Tokens expire and can be rotated or revoked in account settings. Legacy credentials are frozen to current memberships and expire within 30 days of the security migration; rotate them before that deadline. Losing project access removes it immediately; revoke a token from your account and never put it in frontend code or source control.

No comments, status changes, fix verification or code mutations are exposed. Run `npm test` before release. Coordinate this incompatible tool removal with the API reporting release; existing published versions are unchanged until a new package is published.

Development and CI use Node 24 from `.nvmrc`; the published stdio runtime remains compatible with its declared Node 20+ contract. Run `npm ci --ignore-scripts` and `npm test` before packaging.

## Releasing

Bump the version (`npm version patch`, or tag by hand with `git tag -a vX.Y.Z -m X.Y.Z` when `package.json` already has it) and `git push --follow-tags`. Only admins may push `v*` tags, and the tag's commit must be on `main`. The Release workflow tests the package and stages the version on npm through trusted publishing; nothing goes live yet. Approve it on npmjs.com → Staged Packages → Approve with your security key, or with `npm stage approve <id>`. The trusted publisher is set up without "Allow npm publish", so a tag can never put a version live on its own.
