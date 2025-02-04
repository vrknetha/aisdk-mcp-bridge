import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { EventEmitter } from 'events';
import { Request, Response } from 'express';
import { Server as HttpServer } from 'http';

const app = express();
// Configure CORS for SSE
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);
app.use(express.json());

// Server state management
const state = {
  port: parseInt(process.env.MCP_SERVER_PORT || '3005', 10),
  server: null as HttpServer | null,
  isShuttingDown: false,
  isInitialized: false,
  startTime: Date.now(),
  healthCheckInterval: null as NodeJS.Timeout | null,
  activeConnections: new Set<Response>(),
  heartbeatInterval: null as NodeJS.Timeout | null,
};

const emitter = new EventEmitter();
emitter.setMaxListeners(100); // Increase max listeners

// Define the subscription tool
const subscriptionTool = {
  name: 'subscribeToUpdates',
  description: 'Subscribe to real-time updates',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Topic to subscribe to',
      },
    },
    required: ['topic'],
  },
  handler: async (params: { topic: string }) => {
    if (state.isShuttingDown) {
      throw new Error('Server is shutting down');
    }
    if (!state.isInitialized) {
      throw new Error('Server is still initializing');
    }

    emitter.emit('update', {
      topic: params.topic,
      timestamp: new Date().toISOString(),
    });

    return {
      type: 'success',
      value: {
        content: [
          {
            type: 'text',
            text: `Subscribed to ${params.topic}`,
          },
        ],
      },
    };
  },
} satisfies Tool;

// Create MCP server
const mcpServer = new Server(
  {
    name: 'sse-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {
        subscribeToUpdates: subscriptionTool,
      },
    },
  }
);

// Health check endpoint with detailed status
app.get('/health', (_: Request, res: Response) => {
  const status = {
    status: state.isShuttingDown
      ? 'shutting_down'
      : state.isInitialized
        ? 'ready'
        : 'starting',
    uptime: Date.now() - state.startTime,
    port: state.port,
    connections: state.activeConnections.size,
  };

  if (state.isShuttingDown) {
    res.status(503).json(status);
  } else if (!state.isInitialized) {
    res.status(503).json(status);
  } else {
    res.json(status);
  }
});

// Tools endpoint with error handling
app.get('/tools', async (_: Request, res: Response) => {
  try {
    if (!state.isInitialized) {
      res.status(503).json({ error: 'Server is still initializing' });
      return;
    }
    if (state.isShuttingDown) {
      res.status(503).json({ error: 'Server is shutting down' });
      return;
    }
    const tools = [subscriptionTool];
    res.json(tools);
  } catch (error) {
    console.error('Error retrieving tools:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// Execute tool endpoint with improved error handling
app.post('/execute', async (req: Request, res: Response) => {
  try {
    if (!state.isInitialized) {
      res.status(503).json({ error: 'Server is still initializing' });
      return;
    }
    if (state.isShuttingDown) {
      res.status(503).json({ error: 'Server is shutting down' });
      return;
    }

    const { toolName, params } = req.body;
    const tool =
      toolName === 'subscribeToUpdates' ? subscriptionTool : undefined;

    if (!tool) {
      res.status(404).json({ error: `Tool ${toolName} not found` });
      return;
    }

    const result = await tool.handler(params);
    res.json(result);
  } catch (error) {
    console.error('Error executing tool:', error);
    res
      .status(
        error instanceof Error && error.message.includes('validation')
          ? 400
          : 500
      )
      .json({
        error:
          error instanceof Error ? error.message : 'Unknown error occurred',
        details: error instanceof Error ? error.stack : undefined,
      });
  }
});

// SSE endpoint with improved connection handling
app.get('/events', (req: Request, res: Response) => {
  if (!state.isInitialized) {
    res.status(503).json({ error: 'Server is still initializing' });
    return;
  }
  if (state.isShuttingDown) {
    res.status(503).end();
    return;
  }

  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'true',
  });

  // Track connection
  state.activeConnections.add(res);

  // Send initial connection message
  res.write('data: {"type": "connected"}\n\n');

  // Setup heartbeat for this connection
  const heartbeatInterval = setInterval(() => {
    if (!res.closed) {
      res.write(':\n\n'); // Empty comment to keep connection alive
    }
  }, 30000);

  // Handle updates
  const listener = (data: unknown) => {
    if (!res.closed) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  emitter.on('update', listener);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(heartbeatInterval);
    state.activeConnections.delete(res);
    emitter.off('update', listener);
  });

  // Handle errors
  req.on('error', error => {
    console.error('SSE connection error:', error);
    clearInterval(heartbeatInterval);
    state.activeConnections.delete(res);
    emitter.off('update', listener);
  });
});

// Improved port finding with timeout and retries
async function findAvailablePort(
  startPort: number,
  maxRetries = 10
): Promise<number> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const port = startPort + attempt;
      await new Promise<void>((resolve, reject) => {
        const testServer = app.listen(port);
        const timeout = setTimeout(() => {
          testServer.close();
          reject(new Error('Port check timeout'));
        }, 3000);

        testServer.once('listening', () => {
          clearTimeout(timeout);
          testServer.close(() => resolve());
        });

        testServer.once('error', (err: NodeJS.ErrnoException) => {
          clearTimeout(timeout);
          if (err.code === 'EADDRINUSE') {
            resolve(); // Continue to next port
          } else {
            reject(err);
          }
        });
      });

      console.log(`Found available port: ${port}`);
      return port;
    } catch (error) {
      if (attempt === maxRetries - 1) {
        throw new Error(
          `No available ports found after ${maxRetries} attempts`
        );
      }
    }
  }
  throw new Error('Port finding failed');
}

// Start server with initialization checks
export async function startServer(): Promise<void> {
  if (state.server) {
    throw new Error('Server is already running');
  }

  try {
    // Find available port
    state.port = await findAvailablePort(state.port);
    console.log(`Starting SSE server on port ${state.port}...`);

    return new Promise((resolve, reject) => {
      const startTimeout = setTimeout(() => {
        reject(new Error('Server startup timeout'));
      }, 10000);

      state.server = app.listen(state.port, async () => {
        try {
          // Update environment variable with actual port
          process.env.MCP_SERVER_PORT = state.port.toString();

          // Initialize health check
          state.healthCheckInterval = setInterval(() => {
            if (state.server && !state.isShuttingDown) {
              state.server.getConnections((err, count) => {
                if (err) {
                  console.error('Health check error:', err);
                } else {
                  console.debug(`Active connections: ${count}`);
                }
              });
            }
          }, 30000);

          // Initialize heartbeat for all connections
          state.heartbeatInterval = setInterval(() => {
            state.activeConnections.forEach(connection => {
              if (!connection.closed) {
                connection.write(':\n\n'); // Empty comment to keep connection alive
              } else {
                state.activeConnections.delete(connection);
              }
            });
          }, 30000);

          // Wait for initialization
          await new Promise(resolve => setTimeout(resolve, 2000));
          state.isInitialized = true;

          console.log(`SSE server ready on port ${state.port}`);
          clearTimeout(startTimeout);
          resolve();
        } catch (error) {
          clearTimeout(startTimeout);
          console.error('Failed to initialize server:', error);
          reject(error);
        }
      });

      state.server.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(startTimeout);
        console.error('Server error:', error);
        reject(error);
      });
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    throw error;
  }
}

// Improved shutdown with cleanup
export async function stopServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!state.server) {
      resolve();
      return;
    }

    state.isShuttingDown = true;

    // Clear intervals
    if (state.healthCheckInterval) {
      clearInterval(state.healthCheckInterval);
      state.healthCheckInterval = null;
    }
    if (state.heartbeatInterval) {
      clearInterval(state.heartbeatInterval);
      state.heartbeatInterval = null;
    }

    // Close all active connections
    state.activeConnections.forEach(connection => {
      try {
        connection.end();
      } catch (error) {
        console.error('Error closing SSE connection:', error);
      }
    });
    state.activeConnections.clear();

    // Give existing requests time to complete
    const shutdownTimeout = setTimeout(() => {
      console.log('Force closing remaining connections...');
      state.server?.close();
    }, 5000);

    state.server.close(error => {
      clearTimeout(shutdownTimeout);
      if (error) {
        console.error('Error closing server:', error);
        reject(error);
      } else {
        console.log('Server closed successfully');
        state.server = null;
        state.isShuttingDown = false;
        state.isInitialized = false;
        resolve();
      }
    });
  });
}

// Export MCP server
export { mcpServer };

// Graceful shutdown handlers
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  await stopServer();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Shutting down gracefully...');
  await stopServer();
  process.exit(0);
});

// Start server
if (require.main === module) {
  startServer().catch(error => {
    console.error('Failed to start SSE server:', error);
    process.exit(1);
  });
}
