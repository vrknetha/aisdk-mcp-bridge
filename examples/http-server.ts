import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Request, Response } from 'express';
import { Server as HttpServer } from 'http';

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.MCP_SERVER_PORT || 3002;
let server: HttpServer | null = null;

// Define the echo tool
const echoTool = {
  name: 'echo',
  description: 'Echo back the input message',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Message to echo',
      },
    },
    required: ['message'],
  },
  handler: async (params: { message: string }) => {
    return {
      type: 'success',
      value: {
        content: [
          {
            type: 'text',
            text: `Echo: ${params.message}`,
          },
        ],
      },
    };
  },
} satisfies Tool;

// Create MCP server
const mcpServer = new Server(
  {
    name: 'http-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {
        echo: echoTool,
      },
    },
  }
);

// Add health check endpoint
app.get('/health', (_: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Tools endpoint
app.get('/tools', async (_: Request, res: Response) => {
  try {
    const tools = [echoTool];
    res.json(tools);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

// Execute tool endpoint
app.post('/execute', async (req: Request, res: Response) => {
  const { toolName, params } = req.body;
  try {
    const tool = toolName === 'echo' ? echoTool : undefined;
    if (!tool) {
      throw new Error(`Tool ${toolName} not found`);
    }
    const result = await tool.handler(params);
    res.json(result);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

// Start server function
export async function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      server = app.listen(port, () => {
        console.log(`HTTP server listening on port ${port}`);
        resolve();
      });

      server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`Port ${port} is already in use`);
          reject(error);
        } else {
          console.error('Server error:', error);
          reject(error);
        }
      });
    } catch (error) {
      console.error('Failed to start server:', error);
      reject(error);
    }
  });
}

// Stop server function
export async function stopServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }

    server.close(error => {
      if (error) {
        console.error('Error closing server:', error);
        reject(error);
      } else {
        console.log('Server closed successfully');
        server = null;
        resolve();
      }
    });
  });
}

// Export MCP server for external use
export { mcpServer };

// Handle process termination
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
