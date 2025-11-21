import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { albumTools } from './albums.js';
import { playTools } from './play.js';
import { readTools } from './read.js';
import {
  extractRefreshTokenFromHeaders,
  runWithRefreshToken,
} from './utils.js';

const server = new McpServer({
  name: 'spotify-controller',
  version: '1.0.0',
});

const allTools = [...readTools, ...playTools, ...albumTools];
allTools.forEach((tool) => {
  server.tool(tool.name, tool.description, tool.schema, tool.handler);
});

console.log(`Registered ${allTools.length} tools:`, allTools.map(t => t.name).join(', '));

async function main() {
  // Check if we should use stdio (for Cursor IDE) or HTTP (for kagent/web clients)
  const useStdio = process.env.MCP_TRANSPORT === 'stdio' || process.argv.includes('--stdio');

  if (useStdio) {
    // Stdio transport for Cursor IDE and other stdio-based clients
    // Note: For stdio transport, refresh token should be passed via environment variable
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  // HTTP transport for kagent and web clients
  const port = process.env.PORT ? Number.parseInt(process.env.PORT) : 8888;
  const host = process.env.HOST || '0.0.0.0';

  // Create HTTP transport
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: false, // Use SSE streaming
  });

  // server.connect() will call transport.start() internally
  await server.connect(transport);

  // Create HTTP server
  const httpServer = http.createServer(async (req, res) => {
    try {
      // Handle /mcp endpoint (for Cursor IDE) or root / (for kagent)
      const url = req.url || '/';
      if (url !== '/' && url !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Not Found' },
            id: null,
          }),
        );
        return;
      }

      // Extract refresh token from headers
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key.toLowerCase()] = value;
      }

      const refreshToken = extractRefreshTokenFromHeaders(headers);

      if (!refreshToken) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message:
                'Missing refresh token. Include Token header with the refresh token.',
            },
            id: null,
          }),
        );
        return;
      }

      // Log the token (first 20 chars for security)
      const tokenPreview =
        refreshToken.length > 20
          ? `${refreshToken.substring(0, 20)}...`
          : refreshToken;
      console.log(
        `[${new Date().toISOString()}] ${req.method} ${url} - Token: ${tokenPreview}`,
      );

      // Parse request body if present
      let parsedBody: unknown = undefined;
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        if (body) {
          try {
            parsedBody = JSON.parse(body);
            // Log MCP method if it's a JSON-RPC request
            if (parsedBody && typeof parsedBody === 'object' && 'method' in parsedBody) {
              console.log(`[${new Date().toISOString()}] MCP method: ${parsedBody.method}`);
            }
          } catch (e) {
            parsedBody = body;
          }
        }
      }

      // Run request within refresh token context
      try {
        await runWithRefreshToken(refreshToken, async () => {
          await transport.handleRequest(req, res, parsedBody);
        });
        console.log(`[${new Date().toISOString()}] Request completed successfully`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Error in request handler:`, error);
        throw error;
      }
    } catch (error) {
      console.error('Error handling request:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message:
                error instanceof Error ? error.message : 'Internal error',
            },
            id: null,
          }),
        );
      }
    }
  });

  httpServer.listen(port, host, () => {
    console.log(`Spotify MCP Server listening on http://${host}:${port}`);
    console.log(
      `Add to kagent with: kagent add-mcp spotify-mcp --remote http://${host}:${port} --header "Token=\${REFRESH_TOKEN}"`,
    );
  });

  httpServer.on('error', (error) => {
    console.error('HTTP server error:', error);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
