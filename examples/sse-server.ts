import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  ListToolsResultSchema,
  CallToolResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createServer } from 'net';

// Server state
const state = {
  server: null as any,
  isShuttingDown: false,
  isInitialized: false,
  startTime: Date.now(),
  activeConnections: new Set<express.Response>(),
};

// Create Express app
const app = express();
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);
app.use(express.json());

// Create MCP server with capabilities
const mcpServer = new McpServer({
  name: 'sse-server',
  version: '1.0.0',
  capabilities: {
    tools: true,
  },
});

// Register subscription tool
const subscribeHandler = async (
  {
    topic,
    options = {},
  }: {
    topic: string;
    options?: { reconnectTimeout?: number; heartbeatInterval?: number };
  },
  extra: RequestHandlerExtra
) => {
  if (state.isShuttingDown) {
    throw new Error('Server is shutting down');
  }
  return {
    content: [{ type: 'text' as const, text: `Subscribed to ${topic}` }],
  };
};

// Initialize server state
async function initializeServer() {
  if (state.isInitialized) return;

  try {
    // Register tools before accepting connections
    mcpServer.tool(
      'subscribe',
      {
        topic: z.string(),
        options: z
          .object({
            reconnectTimeout: z.number().optional(),
            heartbeatInterval: z.number().optional(),
          })
          .optional(),
      },
      subscribeHandler
    );

    // Mark as initialized after tool registration
    state.isInitialized = true;
  } catch (error) {
    console.error('Failed to initialize server:', error);
    throw error;
  }
}

// Health check endpoint
app.get('/health', (_req, res) => {
  const status = {
    status: state.isShuttingDown
      ? 'shutting_down'
      : state.isInitialized
        ? 'ready'
        : 'starting',
    uptime: Date.now() - state.startTime,
    connections: state.activeConnections.size,
    mcp: {
      serverName: 'sse-server',
      toolCount: 1,
    },
  };

  res
    .status(state.isInitialized && !state.isShuttingDown ? 200 : 503)
    .json(status);
});

// SSE endpoint
app.get('/sse', async (req, res) => {
  if (!state.isInitialized || state.isShuttingDown) {
    res.status(503).json({ error: 'Server not ready' });
    return;
  }

  try {
    // Set headers for SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Create SSE transport with proper endpoint
    const transport = new SSEServerTransport('/messages', res);

    // Connect transport to MCP server
    await mcpServer.connect(transport);

    // Track connection
    state.activeConnections.add(res);

    // Send initial connection message
    const connectionId =
      Date.now().toString(36) + Math.random().toString(36).substr(2);
    const initialMessage = {
      jsonrpc: '2.0',
      method: 'notifications/connected',
      params: {
        id: connectionId,
        status: 'ready',
        server: {
          name: 'sse-server',
          version: '1.0.0',
          capabilities: {
            tools: true,
          },
        },
      },
    };
    res.write(`data: ${JSON.stringify(initialMessage)}\n\n`);

    // Setup heartbeat
    const heartbeatInterval = setInterval(() => {
      try {
        if (!res.closed) {
          const heartbeat = {
            jsonrpc: '2.0',
            method: 'notifications/heartbeat',
            params: { timestamp: Date.now() },
          };
          res.write(`data: ${JSON.stringify(heartbeat)}\n\n`);
        }
      } catch (error) {
        console.error('Heartbeat error:', error);
        cleanup();
      }
    }, 30000);

    // Cleanup function
    const cleanup = () => {
      clearInterval(heartbeatInterval);
      state.activeConnections.delete(res);
      if (!res.closed) {
        res.end();
      }
    };

    // Handle connection events
    req.on('close', cleanup);
    req.on('error', error => {
      console.error('SSE connection error:', error);
      cleanup();
    });

    transport.onclose = cleanup;
    transport.onerror = error => {
      console.error('Transport error:', error);
      cleanup();
    };
  } catch (error) {
    console.error('SSE endpoint error:', error);
    if (!res.closed) {
      res.status(500).end();
    }
  }
});

// Message endpoint for SSE with improved error handling
app.post('/messages', async (req, res) => {
  try {
    if (!state.isInitialized || state.isShuttingDown) {
      throw new Error(
        state.isShuttingDown
          ? 'Server is shutting down'
          : 'Server is initializing'
      );
    }

    // Create an abort controller with timeout
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 30000);

    const extra: RequestHandlerExtra = {
      signal: abortController.signal,
    };

    try {
      // Handle MCP requests
      const { jsonrpc, id, method, params } = req.body;

      if (jsonrpc !== '2.0') {
        throw new Error('Invalid JSON-RPC version');
      }

      let result;
      switch (method) {
        case 'tools/list': {
          result = {
            tools: [
              {
                name: 'subscribe',
                description: 'Subscribe to a topic',
                inputSchema: {
                  type: 'object',
                  properties: {
                    topic: { type: 'string' },
                    options: {
                      type: 'object',
                      properties: {
                        reconnectTimeout: { type: 'number' },
                        heartbeatInterval: { type: 'number' },
                      },
                    },
                  },
                  required: ['topic'],
                },
              },
            ],
          };
          break;
        }
        case 'tools/call': {
          const { name, arguments: args } = params;
          if (name === 'subscribe') {
            result = await subscribeHandler(args, extra);
          } else {
            throw new Error(`Tool not found: ${name}`);
          }
          break;
        }
        default:
          throw new Error(`Unknown method: ${method}`);
      }

      // Send JSON-RPC response
      res.status(200).json({
        jsonrpc: '2.0',
        id,
        result,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const status =
      error instanceof Error &&
      (error.message.includes('initializing') ||
        error.message.includes('shutting down'))
        ? 503
        : 500;

    // Send JSON-RPC error response
    res.status(status).json({
      jsonrpc: '2.0',
      id: req.body?.id,
      error: {
        code: status,
        message:
          error instanceof Error ? error.message : 'Unknown error occurred',
      },
    });
  }
});

// Helper function to check if port is available
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const tester = createServer()
      .once('error', () => {
        resolve(false);
      })
      .once('listening', () => {
        tester
          .once('close', () => {
            resolve(true);
          })
          .close();
      })
      .listen(port);
  });
}

// Helper function to find next available port
async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort;
  while (!(await isPortAvailable(port))) {
    port++;
    if (port - startPort > 100) {
      throw new Error('No available ports found in range');
    }
  }
  return port;
}

// Export server functions for MCP integration
export async function startServer(): Promise<void> {
  if (state.server) {
    throw new Error('Server is already running');
  }

  const requestedPort = parseInt(process.env.MCP_SERVER_PORT || '3003', 10);

  try {
    // Check if requested port is available
    const port = await findAvailablePort(requestedPort);
    if (port !== requestedPort) {
      console.log(
        `Port ${requestedPort} is in use, using port ${port} instead`
      );
    }

    // Initialize MCP server before starting HTTP server
    await initializeServer();

    return new Promise((resolve, reject) => {
      try {
        state.server = app.listen(port, () => {
          console.log(`SSE server ready on port ${port}`);
          // Update environment variable with actual port used
          process.env.MCP_SERVER_PORT = port.toString();
          resolve();
        });

        state.server.on('error', (error: Error) => {
          console.error('Server error:', error);
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    throw error;
  }
}

export async function stopServer(): Promise<void> {
  if (!state.server) return;

  state.isShuttingDown = true;
  console.log('Shutting down SSE server...');

  // Close all active connections
  for (const connection of state.activeConnections) {
    connection.end();
  }
  state.activeConnections.clear();

  return new Promise<void>((resolve, reject) => {
    const closeTimeout = setTimeout(() => {
      console.warn('Server close timed out, forcing shutdown');
      if (state.server) {
        state.server.unref(); // Allow the process to exit even if connections are pending
      }
      resolve();
    }, 5000); // 5 second timeout

    state.server.close(async (error?: Error) => {
      clearTimeout(closeTimeout);
      if (error) {
        console.error('Error closing server:', error);
        reject(error);
        return;
      }

      try {
        await mcpServer.close();
        state.isInitialized = false;
        state.server = null;
        console.log('SSE server shutdown complete');
        resolve();
      } catch (closeError) {
        reject(closeError);
      }
    });
  });
}

// Start server if running directly
if (require.main === module) {
  startServer().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });

  // Handle process signals
  process.on('SIGTERM', () => void stopServer());
  process.on('SIGINT', () => void stopServer());
}

// Export for testing
export { mcpServer };
