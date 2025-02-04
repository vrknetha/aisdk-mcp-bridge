import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Request, Response } from 'express';
import { Server as HttpServer } from 'http';
import { createServer } from 'net';
import { AddressInfo } from 'net';
import { z } from 'zod';
import {
  ListToolsResultSchema,
  CallToolResultSchema,
} from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(cors());
app.use(express.json());

// Server state management
const state = {
  port: parseInt(process.env.MCP_SERVER_PORT || '3004', 10),
  server: null as HttpServer | null,
  isShuttingDown: false,
  isInitialized: false,
  startTime: Date.now(),
  healthCheckInterval: null as NodeJS.Timeout | null,
};

// Create MCP server
const mcpServer = new McpServer({
  name: 'http-server',
  version: '1.0.0',
});

// Register the echo tool
mcpServer.tool(
  'echo',
  'Echo back the input message',
  {
    message: z.string().describe('Message to echo'),
  },
  async (args, extra) => {
    if (state.isShuttingDown) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: 'Server is shutting down',
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: `Echo: ${args.message}`,
        },
      ],
    };
  }
);

// MCP endpoints
app.get('/tools', async (_req: Request, res: Response) => {
  try {
    if (!state.isInitialized) {
      res.status(503).json({ error: 'Server is still initializing' });
      return;
    }
    if (state.isShuttingDown) {
      res.status(503).json({ error: 'Server is shutting down' });
      return;
    }
    const tools = await mcpServer.server.request(
      { method: 'tools/list' },
      ListToolsResultSchema
    );
    res.json(tools);
  } catch (error) {
    console.error('Error listing tools:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

app.post('/tools/call', async (req: Request, res: Response) => {
  try {
    if (!state.isInitialized) {
      res.status(503).json({ error: 'Server is still initializing' });
      return;
    }
    if (state.isShuttingDown) {
      res.status(503).json({ error: 'Server is shutting down' });
      return;
    }

    const { name, arguments: args } = req.body;
    const result = await mcpServer.server.request(
      {
        method: 'tools/call',
        params: {
          name,
          arguments: args,
        },
      },
      CallToolResultSchema
    );
    res.json(result);
  } catch (error) {
    console.error('Error executing tool:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

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
  };

  if (state.isShuttingDown) {
    res.status(503).json(status);
  } else if (!state.isInitialized) {
    res.status(503).json(status);
  } else {
    res.json(status);
  }
});

// Start server with initialization checks
export async function startServer(): Promise<void> {
  if (state.server) {
    throw new Error('Server is already running');
  }

  try {
    // Use configured port directly, only find available if busy
    state.port = parseInt(process.env.MCP_SERVER_PORT || '3004', 10);
    console.log(`Starting HTTP server on port ${state.port}...`);

    try {
      state.server = await new Promise((resolve, reject) => {
        const server = app.listen(state.port);
        server.once('listening', () => resolve(server));
        server.once('error', async (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            console.log(`Port ${state.port} is busy, finding another port...`);
            try {
              state.port = await findAvailablePort(state.port + 1);
              const newServer = app.listen(state.port);
              newServer.once('listening', () => resolve(newServer));
              newServer.once('error', reject);
            } catch (error) {
              reject(error);
            }
          } else {
            reject(err);
          }
        });
      });

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

      // Initialize MCP server
      mcpServer.server.oninitialized = () => {
        state.isInitialized = true;
        console.log(`HTTP server ready on port ${state.port}`);
      };

      // Wait for initialization
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Server initialization timeout'));
        }, 10000);

        const checkInitialized = () => {
          if (state.isInitialized) {
            clearTimeout(timeout);
            resolve(undefined);
          } else {
            setTimeout(checkInitialized, 100);
          }
        };
        checkInitialized();
      });
    } catch (error) {
      console.error('Failed to initialize server:', error);
      throw error;
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    throw error;
  }
}

// Helper function to find an available port
async function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', () => {
      startPort++;
      server.listen(startPort);
    });
    server.on('listening', () => {
      const address = server.address() as AddressInfo;
      if (!address || typeof address === 'string') {
        reject(new Error('Could not get port from server'));
        return;
      }
      server.close(() => resolve(address.port));
    });
    server.listen(startPort);
  });
}

// Cleanup function
export async function cleanup(): Promise<void> {
  state.isShuttingDown = true;
  console.log('Shutting down HTTP server...');

  if (state.healthCheckInterval) {
    clearInterval(state.healthCheckInterval);
    state.healthCheckInterval = null;
  }

  if (state.server) {
    await new Promise<void>((resolve, reject) => {
      state.server?.close(err => {
        if (err) {
          console.error('Error closing server:', err);
          reject(err);
        } else {
          console.log('HTTP server closed');
          state.server = null;
          resolve();
        }
      });
    });
  }
}

// Start the server if this is the main module
if (require.main === module) {
  startServer().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });

  // Handle cleanup on process termination
  process.on('SIGINT', async () => {
    try {
      await cleanup();
      process.exit(0);
    } catch (error) {
      console.error('Error during cleanup:', error);
      process.exit(1);
    }
  });
}
