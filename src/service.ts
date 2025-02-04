import { ToolSet } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { log, jsonSchemaToZod, createDefaultSchema } from './tools';
import { toStdioParams } from './index';
import { MCPServerManager, ServerConfig, MCPServersConfig } from './server';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { JSONSchema7 } from 'json-schema';
import fs from 'fs';
import path from 'path';
import * as z from 'zod';

export interface MCPToolResult {
  content: Array<{
    type: string;
    text: string;
  }>;
  isError?: boolean;
}

export class MCPService {
  private static instance: MCPService;
  private clients: Map<string, Client>;
  private transports: Map<string, StdioClientTransport>;
  private tools: Map<string, ToolSet>;
  private initialized: boolean;
  private serverManager: MCPServerManager | null;

  private constructor() {
    this.clients = new Map();
    this.transports = new Map();
    this.tools = new Map();
    this.initialized = false;
    this.serverManager = null;

    // Handle process signals for graceful shutdown
    process.on('SIGTERM', this.handleShutdown.bind(this));
    process.on('SIGINT', this.handleShutdown.bind(this));
  }

  public static getInstance(): MCPService {
    if (!MCPService.instance) {
      MCPService.instance = new MCPService();
    }
    return MCPService.instance;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  public getConfig(): MCPServersConfig {
    if (!this.serverManager) {
      throw new Error('Server manager not initialized');
    }
    return this.serverManager.getConfig();
  }

  public setServerManager(serverManager: MCPServerManager): void {
    this.serverManager = serverManager;
  }

  private async initializeServer(
    serverName: string,
    serverConfig: ServerConfig,
    options: { debug?: boolean } = {}
  ): Promise<void> {
    const { debug = false } = options;
    log(`Initializing server ${serverName}`, undefined, { debug });

    try {
      // Start the server with timeout
      const startTimeout = new Promise((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(`Server ${serverName} start timeout after 30 seconds`)
          );
        }, 30000);
      });

      // Start server with timeout race
      const started = await Promise.race([
        this.serverManager!.startServer(serverName),
        startTimeout,
      ]);

      if (!started) {
        throw new Error(`Failed to start server ${serverName}`);
      }

      log(`Server ${serverName} started successfully`, undefined, { debug });

      // Create client if not exists with timeout
      if (!this.clients.has(serverName)) {
        log(`Creating new client for ${serverName}`, undefined, { debug });
        const client = new Client({
          name: 'mcp-bridge',
          version: '1.0.0',
        });

        // Convert config to StdioServerParameters
        const stdioParams = toStdioParams(serverConfig);

        // For stdio servers, we need to handle stderr differently
        if (serverConfig.mode === 'stdio') {
          stdioParams.stderr = 'pipe';
        }

        const transport = new StdioClientTransport(stdioParams);

        // Set up error handling
        transport.onerror = (error: Error) => {
          // Only log actual errors, ignore ENOENT for npx as it's expected
          if (error.message.includes('spawn npx ENOENT')) {
            log('Ignoring expected npx ENOENT error', undefined, { debug });
            return;
          }
          log(`Transport error for ${serverName}`, error, {
            type: 'error',
            debug,
          });
        };

        // Connect with timeout and retry
        const maxRetries = 3;
        let retryCount = 0;
        let lastError: Error | null = null;

        while (retryCount < maxRetries) {
          try {
            const connectTimeout = new Promise<void>((_, reject) => {
              setTimeout(() => {
                reject(
                  new Error(
                    `Client connection timeout for ${serverName} after 15 seconds`
                  )
                );
              }, 15000);
            });

            await Promise.race([client.connect(transport), connectTimeout]);

            // Connection successful
            this.clients.set(serverName, client);
            this.transports.set(serverName, transport);
            log(`Client created and connected for ${serverName}`, undefined, {
              debug,
            });
            break;
          } catch (error) {
            lastError = error as Error;
            retryCount++;
            if (retryCount < maxRetries) {
              log(
                `Retrying connection for ${serverName} (attempt ${retryCount + 1}/${maxRetries})`,
                undefined,
                { debug }
              );
              await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s between retries
            }
          }
        }

        if (retryCount === maxRetries) {
          throw new Error(
            `Failed to connect to ${serverName} after ${maxRetries} attempts: ${lastError?.message}`
          );
        }
      }

      // Get tools with timeout and retry
      const client = this.clients.get(serverName)!;
      log(`Requesting tools from ${serverName}...`, undefined, { debug });

      const maxToolRetries = 3;
      let toolRetryCount = 0;
      let lastToolError: Error | null = null;

      while (toolRetryCount < maxToolRetries) {
        try {
          const toolsTimeout = new Promise((_, reject) => {
            setTimeout(() => {
              reject(
                new Error(
                  `Tools request timeout for ${serverName} after 10 seconds`
                )
              );
            }, 10000);
          });

          const response = (await Promise.race([
            client.request({ method: 'tools/list' }, ListToolsResultSchema),
            toolsTimeout,
          ])) as z.infer<typeof ListToolsResultSchema>;

          // Store tools in the map
          const toolSet: ToolSet = {};
          for (const tool of response.tools) {
            toolSet[tool.name] = {
              description: tool.description || '',
              parameters: tool.inputSchema
                ? jsonSchemaToZod(tool.inputSchema as JSONSchema7)
                : createDefaultSchema(),
              execute: async (args: unknown) => {
                return client.request(
                  {
                    method: 'tools/call',
                    params: {
                      name: tool.name,
                      arguments: args,
                    },
                  },
                  CallToolResultSchema
                );
              },
            };
          }
          this.tools.set(serverName, toolSet);

          log(`Received and processed tools from ${serverName}:`, response, {
            debug,
          });
          break;
        } catch (error) {
          lastToolError = error as Error;
          toolRetryCount++;
          if (toolRetryCount < maxToolRetries) {
            log(
              `Retrying tools request for ${serverName} (attempt ${toolRetryCount + 1}/${maxToolRetries})`,
              undefined,
              { debug }
            );
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s between retries
          }
        }
      }

      if (toolRetryCount === maxToolRetries) {
        throw new Error(
          `Failed to get tools from ${serverName} after ${maxToolRetries} attempts: ${lastToolError?.message}`
        );
      }
    } catch (error) {
      // Clean up resources on initialization failure
      await this.cleanup();
      throw error;
    }
  }

  public async initialize(options: { debug?: boolean } = {}): Promise<void> {
    if (this.initialized) {
      log('MCP service already initialized', undefined, {
        debug: options.debug,
      });
      return;
    }

    const { debug = false } = options;
    const config = this.serverManager!.getConfig();

    if (!config) {
      throw new Error('No MCP server configuration found');
    }

    const initializationErrors: Record<string, Error> = {};
    let anyServerInitialized = false;

    for (const [serverName, serverConfig] of Object.entries(
      config.mcpServers
    )) {
      if (serverConfig.disabled) {
        log(`Skipping disabled server: ${serverName}`, undefined, { debug });
        continue;
      }

      try {
        await this.initializeServer(serverName, serverConfig, { debug });
        anyServerInitialized = true;
      } catch (error) {
        log(`Failed to initialize server ${serverName}`, error, {
          type: 'error',
        });
        initializationErrors[serverName] = error as Error;
      }
    }

    // If all servers failed to initialize, throw error
    if (!anyServerInitialized) {
      const errorMessage = Object.entries(initializationErrors)
        .map(([name, error]) => `${name}: ${error.message}`)
        .join('\n');
      throw new Error(`All servers failed to initialize:\n${errorMessage}`);
    }

    this.initialized = true;
    log('MCP service initialization complete', undefined, { debug });
  }

  public async cleanup(): Promise<void> {
    log('Cleaning up MCP service', undefined, { type: 'info' });

    // First stop all servers
    if (this.serverManager) {
      await this.serverManager.stopAllServers();
    }

    // Clean up all clients and transports
    for (const [serverName, client] of this.clients.entries()) {
      try {
        await client.close();
        this.clients.delete(serverName);
        this.transports.delete(serverName);
        this.tools.delete(serverName);
      } catch (error) {
        log(`Error cleaning up server ${serverName}`, error, {
          type: 'error',
        });
      }
    }

    this.initialized = false;
    log('MCP service cleanup complete', undefined, { type: 'info' });
  }

  public async getTools(
    options: { debug?: boolean; serverName?: string } = {}
  ): Promise<ToolSet> {
    const { debug = false, serverName } = options;

    if (!this.initialized) {
      log('MCP service not initialized, initializing now...', undefined, {
        debug,
      });
      await this.initialize({ debug });
    }

    const allTools: ToolSet = {};
    const runningServers = serverName
      ? [serverName]
      : this.serverManager!.getRunningServers();

    if (serverName && !this.serverManager!.isServerRunning(serverName)) {
      throw new Error(`Server ${serverName} is not running`);
    }

    log(
      `Found ${runningServers.length} running servers: ${runningServers.join(', ')}`,
      undefined,
      { debug }
    );

    for (const serverName of runningServers) {
      try {
        const tools = this.tools.get(serverName);
        if (!tools) {
          log(
            `No tools found for server ${serverName}, requesting...`,
            undefined,
            { debug }
          );
          await this.initializeServer(
            serverName,
            this.serverManager!.getServerInfo(serverName)!,
            { debug }
          );
        }
        Object.assign(allTools, this.tools.get(serverName) || {});
      } catch (error) {
        log(`Failed to get tools for server ${serverName}`, error, {
          type: 'error',
        });
      }
    }

    return allTools;
  }

  public async executeFunction(
    serverName: string,
    functionName: string,
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`No client found for server: ${serverName}`);
    }

    try {
      const response = await client.request(
        {
          method: 'tools/call',
          params: {
            name: functionName,
            arguments: args,
          },
        },
        CallToolResultSchema
      );

      return response as MCPToolResult;
    } catch (error) {
      log(`Failed to execute function ${functionName}`, error, {
        type: 'error',
      });
      throw error;
    }
  }

  private async handleShutdown(signal: string): Promise<void> {
    log(`${signal} received. Shutting down gracefully...`, undefined, {
      type: 'info',
    });
    try {
      await this.cleanup();
      process.exit(0);
    } catch (error) {
      log('Error during shutdown:', error, { type: 'error' });
      process.exit(1);
    }
  }
}

// Export singleton instance
export const mcpService = MCPService.getInstance();
