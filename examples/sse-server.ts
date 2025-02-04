import express from 'express';
import cors from 'cors';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { EventEmitter } from 'events';
import { Request, Response } from 'express';
import { Server as HttpServer } from 'http';

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.MCP_SERVER_PORT || 3003;
const emitter = new EventEmitter();
let server: HttpServer | null = null;

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

// Add health check endpoint
app.get('/health', (_: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Tools endpoint
app.get('/tools', async (_: Request, res: Response) => {
  try {
    const tools = [subscriptionTool];
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
    const tool =
      toolName === 'subscribeToUpdates' ? subscriptionTool : undefined;
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

// SSE endpoint
app.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send initial connection message
  res.write('data: {"type": "connected"}\n\n');

  // Handle updates
  const listener = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  emitter.on('update', listener);

  // Clean up on client disconnect
  req.on('close', () => {
    emitter.off('update', listener);
  });
});

// Start server function
export async function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      server = app.listen(port, () => {
        console.log(`SSE server listening on port ${port}`);
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
