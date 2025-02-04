import { z } from 'zod';
import { spawn, ChildProcess } from 'child_process';
import axios from 'axios';

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

interface RunningServer {
  process: ChildProcess | null; // null for SSE servers
  port: number;
  mode: 'http' | 'stdio' | 'sse';
  sseClient?: EventSource;
}

export class MCPServerManager {
  private static instance: MCPServerManager;
  private servers: Map<string, RunningServer> = new Map();
  private config: MCPServersConfig | null = null;
  private nextPort: number = 3000;

  private constructor() {}

  public static getInstance(): MCPServerManager {
    if (!MCPServerManager.instance) {
      MCPServerManager.instance = new MCPServerManager();
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
      this.servers.clear();
      this.nextPort = 3000;

      return true;
    } catch (error) {
      console.error('Invalid server configuration:', error);
      throw error;
    }
  }

  public getConfig(): MCPServersConfig | null {
    return this.config;
  }

  public getServerInfo(serverName: string): RunningServer | null {
    return this.servers.get(serverName) || null;
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
      console.log(`Starting ${serverName} in stdio mode...`);
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
        console.log(`[${serverName}] ${data.toString()}`);
      });

      server.stderr.on('data', data => {
        serverOutput += data.toString();
        console.error(`[${serverName}] Error: ${data.toString()}`);
      });

      server.on('close', code => {
        console.log(`[${serverName}] Server exited with code ${code}`);
        this.servers.delete(serverName);
      });

      // Store server reference
      this.servers.set(serverName, {
        process: server,
        port: -1, // No port for stdio mode
        mode: 'stdio',
      });
      console.log(`[${serverName}] Server registered in stdio mode`);

      // Wait a bit for the server to initialize
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify server is still registered
      if (!this.servers.has(serverName)) {
        console.error(
          `[${serverName}] Server registration lost during initialization`
        );
        return false;
      }

      console.log(`[${serverName}] Server initialization complete`);
      return true;
    } catch (error) {
      console.error(`Failed to start stdio server ${serverName}:`, error);
      return false;
    }
  }

  private async startHttpServer(
    serverName: string,
    serverConfig: ServerConfig
  ): Promise<boolean> {
    try {
      const port = serverConfig.port || this.getNextPort();
      console.log(`Starting ${serverName} in HTTP mode on port ${port}...`);

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
        console.log(`[${serverName}] ${data.toString()}`);
      });

      server.stderr.on('data', data => {
        serverOutput += data.toString();
        console.error(`[${serverName}] Error: ${data.toString()}`);
      });

      server.on('close', code => {
        console.log(`[${serverName}] Server exited with code ${code}`);
        this.servers.delete(serverName);
      });

      // Store server reference
      this.servers.set(serverName, { process: server, port, mode: 'http' });

      // Wait for server to be ready
      const isReady = await this.waitForServer(port);
      if (!isReady) {
        console.error(
          `Failed to start ${serverName} server. Server output:\n${serverOutput}`
        );
        await this.stopServer(serverName);
        return false;
      }

      console.log(`${serverName} server started successfully on port ${port}`);
      return true;
    } catch (error) {
      console.error(`Failed to start HTTP server ${serverName}:`, error);
      return false;
    }
  }

  private async startSseServer(
    serverName: string,
    serverConfig: ServerConfig
  ): Promise<boolean> {
    if (!serverConfig.sseOptions?.endpoint) {
      console.error(`SSE endpoint not configured for ${serverName}`);
      return false;
    }

    try {
      console.log(`Starting ${serverName} in SSE mode...`);
      const eventSourceInit: CustomEventSourceInit = {
        headers: serverConfig.sseOptions.headers,
      };
      const eventSource = new EventSource(
        serverConfig.sseOptions.endpoint,
        eventSourceInit
      );

      eventSource.onopen = () => {
        console.log(`SSE connection established for ${serverName}`);
      };

      eventSource.onerror = error => {
        console.error(`SSE error for ${serverName}:`, error);
        this.servers.delete(serverName);
      };

      // Store server reference
      this.servers.set(serverName, {
        process: null,
        port: -1,
        mode: 'sse',
        sseClient: eventSource,
      });

      return true;
    } catch (error) {
      console.error(`Failed to start SSE server ${serverName}:`, error);
      return false;
    }
  }

  public async startServer(serverName: string): Promise<boolean> {
    if (!this.config) {
      throw new Error('Configuration not loaded');
    }

    const serverConfig = this.config.mcpServers[serverName];
    if (!serverConfig) {
      throw new Error(`Server ${serverName} not found in configuration`);
    }

    // Skip disabled servers
    if (serverConfig.disabled) {
      console.log(`Server ${serverName} is disabled, skipping...`);
      return false;
    }

    // Check if server is already running
    if (this.servers.has(serverName)) {
      console.log(`Server ${serverName} is already running`);
      return true;
    }

    console.log(
      `Starting server ${serverName} in ${serverConfig.mode} mode...`
    );
    try {
      let success = false;
      switch (serverConfig.mode) {
        case 'stdio':
          success = await this.startStdioServer(serverName, serverConfig);
          break;
        case 'http':
          success = await this.startHttpServer(serverName, serverConfig);
          break;
        case 'sse':
          success = await this.startSseServer(serverName, serverConfig);
          break;
        default:
          throw new Error(`Unsupported server mode: ${serverConfig.mode}`);
      }

      if (success) {
        console.log(`Server ${serverName} started and registered successfully`);
      } else {
        console.error(`Failed to start server ${serverName}`);
      }

      return success;
    } catch (error) {
      console.error(`Failed to start server ${serverName}:`, error);
      return false;
    }
  }

  public async stopServer(serverName: string): Promise<void> {
    const server = this.servers.get(serverName);
    if (!server) {
      return;
    }

    try {
      switch (server.mode) {
        case 'stdio':
        case 'http':
          if (server.process) {
            server.process.kill();
            await new Promise<void>(resolve => {
              if (server.process) {
                server.process.on('exit', () => resolve());
              } else {
                resolve();
              }
            });
          }
          break;
        case 'sse':
          if (server.sseClient) {
            server.sseClient.close();
          }
          break;
      }
    } catch (error) {
      console.error(`Error stopping server ${serverName}:`, error);
    } finally {
      this.servers.delete(serverName);
      console.log(`Server ${serverName} stopped successfully`);
    }
  }

  public async stopAllServers(): Promise<void> {
    const serverNames = Array.from(this.servers.keys());
    await Promise.all(serverNames.map(name => this.stopServer(name)));
  }

  public isServerRunning(serverName: string): boolean {
    return this.servers.has(serverName);
  }

  public getRunningServers(): string[] {
    return Array.from(this.servers.keys());
  }
}
