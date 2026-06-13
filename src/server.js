import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const STATUSES = ['open', 'in-progress', 'resolved'];

/**
 * Build the Rebase MCP server: four tools that let a coding agent pull a bug
 * report's full capture (console, network failures, suspected source location,
 * AI triage, screenshot), reply to the reporter, and resolve the ticket. The
 * agent fixes the code with its own tools — Rebase is the context layer.
 *
 * @param {import('./api.js').RebaseApi} api
 */
export function buildServer(api) {
  const server = new McpServer({ name: 'rebase', version: '0.1.0' });

  server.registerTool(
    'list_tickets',
    {
      description:
        'List the project’s bug reports (newest first). Returns id, title, status, page pathname, AI severity, and duplicate links. Use get_ticket for full context.',
      inputSchema: {
        status: z.enum(STATUSES).optional().describe('Filter by status. Omit for all tickets.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 25).'),
        cursor: z.string().optional().describe('nextCursor from a previous page.'),
      },
    },
    async ({ status, limit, cursor }) => {
      const data = await api.listTickets({ status, limit, cursor });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'get_ticket',
    {
      description:
        'Fetch one bug report with everything captured at report time: description, AI triage (summary, repro steps, severity), pinned element, suspected source locations (symbolicated), console errors, failed network requests, session events, comments, and tracker links. Set include_screenshot to also get the annotated screenshot as an image.',
      inputSchema: {
        ticket_id: z.string().describe('The ticket id (from list_tickets).'),
        include_screenshot: z.boolean().optional().describe('Also return the screenshot as an image block.'),
      },
    },
    async ({ ticket_id: ticketId, include_screenshot: includeScreenshot }) => {
      const ticket = await api.getTicket(ticketId);

      const content = [{ type: 'text', text: JSON.stringify(ticket, null, 2) }];

      if (includeScreenshot && typeof ticket.screenshotUrl === 'string') {
        const data = await api.fetchScreenshotBase64(ticket.screenshotUrl);
        if (data !== null) {
          content.push({ type: 'image', data, mimeType: 'image/png' });
        }
      }

      return { content };
    }
  );

  server.registerTool(
    'add_comment',
    {
      description:
        'Post a comment on a ticket’s thread — visible to the reporter and team in the widget. Use it to ask for details or to note what was fixed.',
      inputSchema: {
        ticket_id: z.string().describe('The ticket id.'),
        body: z.string().min(1).max(5000).describe('The comment text. Plain text; @Full Name mentions notify that member.'),
      },
    },
    async ({ ticket_id: ticketId, body }) => {
      const comment = await api.addComment(ticketId, body);
      return { content: [{ type: 'text', text: JSON.stringify(comment, null, 2) }] };
    }
  );

  server.registerTool(
    'update_ticket_status',
    {
      description:
        'Change a ticket’s status. Resolving removes its pin from the page and notifies watchers — do it only once a fix has actually landed.',
      inputSchema: {
        ticket_id: z.string().describe('The ticket id.'),
        status: z.enum(STATUSES).describe('The new status.'),
      },
    },
    async ({ ticket_id: ticketId, status }) => {
      const result = await api.updateStatus(ticketId, status);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}
