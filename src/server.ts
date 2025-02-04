import { z } from 'zod';
import { spawn, ChildProcess } from 'child_process';
import { log } from './tools';

// Server Configuration Schema
export const ServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string()).optional(),
  mode: z.enum(['stdio', 'sse']).default('stdio'),
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

  private async startSseServer(
    serverName: string,
    serverConfig: ServerConfig
  ): Promise<boolean> {
    try {
      log(`Starting ${serverName} in SSE mode...`, undefined, {
        type: 'info',
      });

      // Create a promise that resolves when the server is ready
      const serverReadyPromise = new Promise<boolean>(resolve => {
        let isReady = false;
        const readyTimeout = setTimeout(() => {
          if (!isReady) {
            log(
              `Server ${serverName} failed to initialize within timeout`,
              undefined,
              {
                type: 'error',
              }
            );
            resolve(false);
          }
        }, 10000); // 10 second timeout

        const server = spawn(serverConfig.command, serverConfig.args, {
          env: {
            ...process.env,
            ...serverConfig.env,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let serverOutput = '';
        server.stdout.on('data', data => {
          const output = data.toString();
          serverOutput += output;
          log(`[${serverName}] ${output}`, undefined, { type: 'info' });

          // Check for server ready message
          if (output.includes('SSE server ready on port')) {
            isReady = true;
            clearTimeout(readyTimeout);

            // Store server reference only after it's ready
            this.runningServers.set(serverName, {
              ...serverConfig,
              process: server,
              mode: 'sse',
              startTime: Date.now(),
            });

            resolve(true);
          }
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
          if (!isReady) {
            resolve(false);
          }
          this.runningServers.delete(serverName);
        });

        server.on('error', error => {
          log(`[${serverName}] Server error: ${error.message}`, undefined, {
            type: 'error',
          });
          if (!isReady) {
            resolve(false);
          }
        });
      });

      // Wait for server to be ready
      const success = await serverReadyPromise;
      if (!success) {
        return false;
      }

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
      log(`Failed to start SSE server ${serverName}`, error, {
        type: 'error',
      });
      return false;
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

      // Start each server independently
      startupPromises.push(
        this.startServer(serverName)
          .then(success => {
            results.set(serverName, success);
            if (!success) {
              log(
                `Server ${serverName} failed to start, continuing with other servers`,
                undefined,
                {
                  type: 'error',
                }
              );
            }
          })
          .catch(error => {
            log(`Error starting server ${serverName}`, error, {
              type: 'error',
            });
            results.set(serverName, false);
            // Don't rethrow - allow other servers to continue
          })
      );
    }

    // Wait for all servers to complete startup attempts
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
          {
            type: 'debug',
          }
        );
        return existingPromise;
      }

      // Create startup promise
      const startupPromise = new Promise<boolean>((resolve, reject) => {
        try {
          log(`Starting server ${serverName}...`, undefined, {
            type: 'debug',
          });

          const startServer = async () => {
            switch (serverConfig.mode) {
              case 'stdio':
                return await this.startStdioServer(serverName, serverConfig);
              case 'sse':
                return await this.startSseServer(serverName, serverConfig);
              default:
                throw new Error(
                  `Unsupported server mode: ${serverConfig.mode}`
                );
            }
          };

          startServer()
            .then(resolve)
            .catch(error => {
              log(`Failed to start server ${serverName}`, error, {
                type: 'error',
              });
              resolve(false); // Resolve with false instead of rejecting
            })
            .finally(() => {
              this.startupPromises.delete(serverName);
            });
        } catch (error) {
          log(`Failed to start server ${serverName}`, error, {
            type: 'error',
          });
          this.startupPromises.delete(serverName);
          resolve(false); // Resolve with false instead of rejecting
        }
      });

      this.startupPromises.set(serverName, startupPromise);
      return startupPromise;
    } catch (error) {
      log(`Error starting server ${serverName}`, error, { type: 'error' });
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
      // Don't rethrow - allow cleanup to continue
    }
  }

  public async stopAllServers(): Promise<void> {
    const serverNames = Array.from(this.runningServers.keys());
    const stopPromises = serverNames.map(name =>
      this.stopServer(name).catch(error => {
        log(`Error stopping server ${name}`, error, { type: 'error' });
        // Don't rethrow - allow other servers to stop
      })
    );
    await Promise.allSettled(stopPromises);
  }

  public isServerRunning(serverName: string): boolean {
    return this.runningServers.has(serverName);
  }

  public getRunningServers(): string[] {
    return Array.from(this.runningServers.keys());
  }
}
