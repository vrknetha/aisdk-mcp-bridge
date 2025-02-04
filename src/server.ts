import { z } from 'zod';
import { spawn, ChildProcess } from 'child_process';
import axios from 'axios';
import { log } from './tools';
import net from 'net';

// Custom EventSource type that supports headers
interface CustomEventSourceInit extends EventSourceInit {
  headers?: Record<string, string>;
}

// Server Configuration Schema
const ServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string()).optional(),
  port: z.number().optional(),
  mode: z.enum(['http', 'stdio', 'sse']).optional().default('stdio'),
  autoApprove: z.array(z.string()).optional(),
  disabled: z.boolean().optional(),
  // SSE specific options
  sseOptions: z
    .object({
      endpoint: z.string(),
      headers: z.record(z.string()).optional(),
      reconnectTimeout: z.number().optional(),
    })
    .optional(),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export const MCPServersConfigSchema = z.object({
  mcpServers: z.record(z.string(), ServerConfigSchema),
});

export type MCPServersConfig = z.infer<typeof MCPServersConfigSchema>;

interface RunningServer extends ServerConfig {
  startTime: number;
  process?: ChildProcess;
}

export class MCPServerManager {
  private static instance: MCPServerManager;
  private config: MCPServersConfig;
  private runningServers: Map<string, RunningServer> = new Map();
  private nextPort: number = 3000;
  private startupPromises: Map<string, Promise<boolean>> = new Map();

  private constructor(config: MCPServersConfig) {
    this.config = config;
  }

  public static getInstance(config: MCPServersConfig): MCPServerManager {
    if (!MCPServerManager.instance) {
      MCPServerManager.instance = new MCPServerManager(config);
    }
    return MCPServerManager.instance;
  }

  public setConfig(config: MCPServersConfig) {
    try {
      // Validate the config using the schema
      const validatedConfig = MCPServersConfigSchema.parse(config);

      // Store the validated config
      this.config = validatedConfig;

      // Reset server state when config changes
      this.runningServers.clear();
      this.nextPort = 3000;

      return true;
    } catch (error) {
      console.error('Invalid server configuration:', error);
      throw error;
    }
  }

  public getConfig(): MCPServersConfig {
    return this.config;
  }

  public getServerInfo(serverName: string): ServerConfig | undefined {
    return this.config.mcpServers[serverName];
  }

  private getNextPort(): number {
    return this.nextPort++;
  }

  private async waitForServer(
    port: number,
    maxAttempts: number = 30
  ): Promise<boolean> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await axios.get(`http://localhost:${port}/health`);
        return true;
      } catch (error) {
        if (attempt === maxAttempts - 1) {
          console.error(
            `Server on port ${port} did not respond after ${maxAttempts} attempts`
          );
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    return false;
  }

  private async startStdioServer(
    serverName: string,
    serverConfig: ServerConfig
  ): Promise<boolean> {
    try {
      log(`Starting ${serverName} in stdio mode...`, undefined, {
        type: 'info',
      });
      const server = spawn(serverConfig.command, serverConfig.args, {
        env: {
          ...process.env,
          ...serverConfig.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let serverOutput = '';
      server.stdout.on('data', data => {
        serverOutput += data.toString();
        log(`[${serverName}] ${data.toString()}`, undefined, { type: 'info' });
      });

      server.stderr.on('data', data => {
        serverOutput += data.toString();
        log(`[${serverName}] Error: ${data.toString()}`, undefined, {
          type: 'error',
        });
      });

      server.on('close', code => {
        log(`[${serverName}] Server exited with code ${code}`, undefined, {
          type: 'info',
        });
        this.runningServers.delete(serverName);
      });

      // Store server reference
      this.runningServers.set(serverName, {
        ...serverConfig,
        process: server,
        port: -1, // No port for stdio mode
        mode: 'stdio',
        startTime: Date.now(),
      });
      log(`[${serverName}] Server registered in stdio mode`, undefined, {
        type: 'info',
      });

      // Wait a bit for the server to initialize
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify server is still registered
      if (!this.runningServers.has(serverName)) {
        log(
          `[${serverName}] Server registration lost during initialization`,
          undefined,
          { type: 'error' }
        );
        return false;
      }

      log(`[${serverName}] Server initialization complete`, undefined, {
        type: 'info',
      });
      return true;
    } catch (error) {
      log(`Failed to start stdio server ${serverName}`, error, {
        type: 'error',
      });
      return false;
    }
  }

  private async startHttpServer(
    serverName: string,
    serverConfig: ServerConfig
  ): Promise<boolean> {
    try {
      // Use configured port or find next available
      const port = serverConfig.port || 3004;
      log(`Starting ${serverName} in HTTP mode on port ${port}...`, undefined, {
        type: 'info',
      });

      // Check if port is available before starting
      try {
        const testServer = net.createServer();
        await new Promise<void>((resolve, reject) => {
          testServer.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
              reject(new Error(`Port ${port} is already in use`));
            } else {
              reject(err);
            }
          });
          testServer.once('listening', () => {
            testServer.close();
            resolve();
          });
          testServer.listen(port);
        });
      } catch (error) {
        log(`Port ${port} is not available for ${serverName}`, error, {
          type: 'error',
        });
        return false;
      }

      const server = spawn(serverConfig.command, serverConfig.args, {
        env: {
          ...process.env,
          ...serverConfig.env,
          PORT: port.toString(),
          MCP_SERVER_PORT: port.toString(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let serverOutput = '';
      server.stdout.on('data', data => {
        serverOutput += data.toString();
        log(`[${serverName}] ${data.toString()}`, undefined, { type: 'info' });
      });

      server.stderr.on('data', data => {
        serverOutput += data.toString();
        log(`[${serverName}] Error: ${data.toString()}`, undefined, {
          type: 'error',
        });
      });

      server.on('close', code => {
        log(`[${serverName}] Server exited with code ${code}`, undefined, {
          type: 'info',
        });
        this.runningServers.delete(serverName);
      });

      // Store server reference
      this.runningServers.set(serverName, {
        ...serverConfig,
        process: server,
        port,
        mode: 'http',
        startTime: Date.now(),
      });

      // Wait for server to be ready with shorter timeout
      const isReady = await this.waitForServer(port, 15);
      if (!isReady) {
        log(
          `Failed to start ${serverName} server. Server output:\n${serverOutput}`,
          undefined,
          { type: 'error' }
        );
        await this.stopServer(serverName);
        return false;
      }

      log(
        `${serverName} server started successfully on port ${port}`,
        undefined,
        { type: 'info' }
      );
      return true;
    } catch (error) {
      log(`Failed to start HTTP server ${serverName}`, error, {
        type: 'error',
      });
      return false;
    }
  }

  private async startSseServer(
    serverName: string,
    serverConfig: RunningServer
  ): Promise<void> {
    try {
      // Validate SSE configuration
      if (!serverConfig.sseOptions?.endpoint) {
        throw new Error(`SSE endpoint not configured for server ${serverName}`);
      }

      log(`Starting ${serverName} in SSE mode...`, undefined, { type: 'info' });

      // Create EventSource with proper configuration
      const eventSourceInit: CustomEventSourceInit = {
        headers: serverConfig.sseOptions.headers,
      };

      const eventSource = new EventSource(
        serverConfig.sseOptions.endpoint,
        eventSourceInit
      );

      // Set up connection timeout
      const connectionTimeout = new Promise<void>((_, reject) => {
        setTimeout(() => {
          eventSource.close();
          reject(
            new Error(
              `SSE connection timeout for ${serverName} after 10 seconds`
            )
          );
        }, 10000);
      });

      // Wait for connection or timeout
      await Promise.race([
        new Promise<void>(resolve => {
          eventSource.onopen = () => {
            log(`SSE connection opened for ${serverName}`, undefined, {
              type: 'info',
            });
            resolve();
          };
        }),
        connectionTimeout,
      ]);

      // Set up error handling with reconnection logic
      const reconnectTimeout = serverConfig.sseOptions.reconnectTimeout || 5000;
      let reconnectAttempt = 0;
      const maxReconnectAttempts = 3;

      eventSource.onerror = async error => {
        log(`SSE error for ${serverName}:`, error, { type: 'error' });
        eventSource.close();

        if (reconnectAttempt < maxReconnectAttempts) {
          reconnectAttempt++;
          log(
            `SSE connection error for ${serverName}, attempting reconnect ${reconnectAttempt}/${maxReconnectAttempts}`,
            undefined,
            { type: 'info' }
          );
          await new Promise(resolve => setTimeout(resolve, reconnectTimeout));
          await this.startSseServer(serverName, serverConfig);
        } else {
          log(
            `SSE connection failed for ${serverName} after ${maxReconnectAttempts} reconnect attempts`,
            undefined,
            { type: 'error' }
          );
          this.runningServers.delete(serverName);
        }
      };

      // Store server reference with EventSource
      const runningServer: RunningServer = {
        ...serverConfig,
        process: undefined,
        port: -1,
        mode: 'sse',
        startTime: Date.now(),
      };

      this.runningServers.set(serverName, runningServer);
      log(`[${serverName}] Server registered in SSE mode`, undefined, {
        type: 'info',
      });
    } catch (error) {
      log(`Failed to start SSE server ${serverName}`, error, { type: 'error' });
      throw error;
    }
  }

  public async startAllServers(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    const startupPromises: Promise<void>[] = [];

    for (const [serverName, serverConfig] of Object.entries(
      this.config.mcpServers
    )) {
      if (serverConfig.disabled) {
        log(`Server ${serverName} is disabled, skipping...`, undefined, {
          type: 'info',
        });
        results.set(serverName, false);
        continue;
      }

      if (this.runningServers.has(serverName)) {
        log(`Server ${serverName} is already running`, undefined, {
          type: 'info',
        });
        results.set(serverName, true);
        continue;
      }

      startupPromises.push(
        this.startServer(serverName).then(success => {
          results.set(serverName, success);
        })
      );
    }

    await Promise.allSettled(startupPromises);
    return results;
  }

  public async startServer(serverName: string): Promise<boolean> {
    const serverConfig = this.getServerInfo(serverName);
    if (!serverConfig) {
      log(`Server ${serverName} not found in configuration`, undefined, {
        type: 'error',
      });
      return false;
    }

    if (this.isServerRunning(serverName)) {
      log(`Server ${serverName} is already running`, undefined, {
        type: 'debug',
      });
      return true;
    }

    try {
      // Check if server is already starting
      const existingPromise = this.startupPromises.get(serverName);
      if (existingPromise) {
        log(
          `Server ${serverName} is already starting, waiting for completion`,
          undefined,
          { type: 'debug' }
        );
        return existingPromise;
      }

      // Create startup promise
      const startupPromise = new Promise<boolean>(resolve => {
        void (async () => {
          try {
            log(`Starting server ${serverName}...`, undefined, {
              type: 'debug',
            });

            const runningServer: RunningServer = {
              ...serverConfig,
              startTime: Date.now(),
            };

            // Start server based on mode
            switch (serverConfig.mode) {
              case 'http':
                await this.startHttpServer(serverName, runningServer);
                break;
              case 'sse':
                await this.startSseServer(serverName, runningServer);
                break;
              case 'stdio':
                await this.startStdioServer(serverName, runningServer);
                break;
              default:
                throw new Error(
                  `Unsupported server mode: ${serverConfig.mode}`
                );
            }

            // Wait for server to be ready
            const isReady = await this.waitForServerReady(
              serverName,
              runningServer
            );
            if (!isReady) {
              throw new Error(`Server ${serverName} failed health check`);
            }

            this.runningServers.set(serverName, runningServer);
            log(`Server ${serverName} started successfully`, undefined, {
              type: 'debug',
            });
            resolve(true);
          } catch (error) {
            log(`Failed to start server ${serverName}`, error, {
              type: 'error',
            });
            resolve(false);
          } finally {
            this.startupPromises.delete(serverName);
          }
        })();
      });

      this.startupPromises.set(serverName, startupPromise);
      return startupPromise;
    } catch (error) {
      log(`Error starting server ${serverName}`, error, { type: 'error' });
      return false;
    }
  }

  private async waitForServerReady(
    serverName: string,
    serverConfig: RunningServer
  ): Promise<boolean> {
    const maxAttempts = 30;
    const retryDelay = 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const isHealthy = await this.checkServerHealth(
          serverName,
          serverConfig
        );
        if (isHealthy) {
          return true;
        }

        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      } catch (error) {
        log(
          `Health check failed for ${serverName} (attempt ${attempt}/${maxAttempts})`,
          error,
          { type: 'debug' }
        );
        if (attempt === maxAttempts) {
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    return false;
  }

  private async checkServerHealth(
    serverName: string,
    serverConfig: RunningServer
  ): Promise<boolean> {
    try {
      switch (serverConfig.mode) {
        case 'http': {
          const port = serverConfig.port || 3004;
          const response = await fetch(`http://localhost:${port}/health`);
          return response.ok;
        }
        case 'sse': {
          const port = serverConfig.port || 3005;
          const response = await fetch(`http://localhost:${port}/health`);
          return response.ok;
        }
        case 'stdio': {
          // For stdio servers, we consider them healthy if they're running
          return true;
        }
        default:
          return false;
      }
    } catch (error) {
      return false;
    }
  }

  public async stopServer(serverName: string): Promise<void> {
    const serverInfo = this.runningServers.get(serverName);
    if (!serverInfo) {
      return;
    }

    try {
      if (serverInfo.process) {
        serverInfo.process.kill();
      }
      this.runningServers.delete(serverName);
      log(`Server ${serverName} stopped`, undefined, { type: 'info' });
    } catch (error) {
      log(`Error stopping server ${serverName}`, error, { type: 'error' });
    }
  }

  public async stopAllServers(): Promise<void> {
    const serverNames = Array.from(this.runningServers.keys());
    await Promise.all(serverNames.map(name => this.stopServer(name)));
  }

  public isServerRunning(serverName: string): boolean {
    return this.runningServers.has(serverName);
  }

  public getRunningServers(): string[] {
    return Array.from(this.runningServers.keys());
  }
}
