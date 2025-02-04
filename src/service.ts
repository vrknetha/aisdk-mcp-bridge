import { ToolSet } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { log, jsonSchemaToZod, createDefaultSchema } from './tools';
import { toStdioParams } from './index';
import { MCPServerManager, ServerConfig } from './server';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { JSONSchema7 } from 'json-schema';
import fs from 'fs';
import path from 'path';

export interface MCPToolResult {
  content: Array<{
    type: string;
    text: string;
  }>;
  isError?: boolean;
}

export class MCPService {
  private static instance: MCPService;
  private serverManager: MCPServerManager;
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, StdioClientTransport> = new Map();
  private tools: Map<string, ToolSet> = new Map();
  private initialized = false;

  private constructor() {
    this.serverManager = MCPServerManager.getInstance();
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

  private async initializeServer(
    serverName: string,
    serverConfig: ServerConfig,
    options: { debug?: boolean } = {}
  ): Promise<void> {
    const { debug = false } = options;
    log(`Initializing server ${serverName}`, undefined, { debug });

    // Start the server first
    const started = await this.serverManager.startServer(serverName);
    if (!started) {
      throw new Error(`Failed to start server ${serverName}`);
    }
    log(`Server ${serverName} started successfully`, undefined, { debug });

    // Create client if not exists
    if (!this.clients.has(serverName)) {
      log(`Creating new client for ${serverName}`, undefined, { debug });
      const client = new Client({
        name: 'linkedin-agent',
        version: '1.0.0',
      });

      // Convert config to StdioServerParameters
      const stdioParams = toStdioParams(serverConfig);
      const transport = new StdioClientTransport(stdioParams);

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

      await client.connect(transport);
      this.clients.set(serverName, client);
      this.transports.set(serverName, transport);
      log(`Client created and connected for ${serverName}`, undefined, {
        debug,
      });
    }

    // Get tools for this server
    const client = this.clients.get(serverName)!;
    log(`Requesting tools from ${serverName}...`, undefined, { debug });
    const response = await client.request(
      { method: 'tools/list' },
      ListToolsResultSchema
    );
    log(`Received tools response from ${serverName}:`, response, { debug });

    // Convert response tools to ToolSet
    const toolSet: ToolSet = {};
    for (const tool of response.tools) {
      // Only log tool conversion if explicitly debugging
      if (debug) {
        log(`Converting tool ${tool.name}`, tool, { debug });
      }

      const zodSchema = tool.inputSchema
        ? jsonSchemaToZod(tool.inputSchema as JSONSchema7, debug)
        : createDefaultSchema();

      toolSet[tool.name] = {
        description: tool.description || '',
        parameters: zodSchema,
        execute: async (args: unknown) => {
          // Only log execution if explicitly debugging
          if (debug) {
            log(`Executing tool ${tool.name}`, args, { debug });
          }
          try {
            const result = await client.request(
              {
                method: 'tools/call',
                params: {
                  name: tool.name,
                  arguments: args,
                },
              },
              CallToolResultSchema
            );
            // Only log result if explicitly debugging
            if (debug) {
              log(`Tool ${tool.name} execution result`, result, { debug });
            }
            return result;
          } catch (error) {
            log(`Tool ${tool.name} execution failed`, error, {
              type: 'error',
            });
            throw error;
          }
        },
      };
    }

    this.tools.set(serverName, toolSet);
    // Only log tools initialization if explicitly debugging
    if (debug) {
      log(`Server ${serverName} initialized with tools`, toolSet, { debug });
    }
  }

  public async initialize(options: { debug?: boolean } = {}): Promise<void> {
    if (this.initialized) {
      return;
    }

    const { debug = false } = options;
    const config = this.serverManager.getConfig();

    if (!config) {
      throw new Error('No MCP server configuration found');
    }

    for (const [serverName, serverConfig] of Object.entries(
      config.mcpServers
    )) {
      if (serverConfig.disabled) {
        log(`Skipping disabled server: ${serverName}`, undefined, { debug });
        continue;
      }

      try {
        await this.initializeServer(serverName, serverConfig, { debug });
      } catch (error) {
        log(`Failed to initialize server ${serverName}`, error, {
          type: 'error',
        });
      }
    }

    this.initialized = true;
  }

  public async cleanup(): Promise<void> {
    log('Cleaning up MCP service', undefined, { type: 'info' });

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
    options: {
      debug?: boolean;
      serverName?: string;
    } = {}
  ): Promise<ToolSet> {
    if (!this.initialized) {
      throw new Error('MCP service not initialized. Call initialize() first.');
    }

    const { debug = false, serverName } = options;
    const allTools: ToolSet = {};
    const rawTools: Record<string, unknown> = {};
    const runningServers = serverName
      ? [serverName]
      : this.serverManager.getRunningServers();

    if (serverName && !this.serverManager.isServerRunning(serverName)) {
      throw new Error(`Server ${serverName} is not running`);
    }

    log(
      `Found ${runningServers.length} running servers: ${runningServers.join(', ')}`,
      undefined,
      { debug }
    );

    for (const serverName of runningServers) {
      try {
        const serverInfo = this.serverManager.getServerInfo(serverName);
        log(
          `Processing server ${serverName}, mode: ${serverInfo?.mode}`,
          undefined,
          { debug }
        );

        if (serverInfo?.mode === 'stdio') {
          // Get raw MCP tools
          const client = this.clients.get(serverName);
          if (client) {
            log(`Requesting tools from server ${serverName}...`, undefined, {
              debug,
            });
            const response = await client.request(
              { method: 'tools/list' },
              ListToolsResultSchema
            );
            log(`Received tools response from ${serverName}:`, response, {
              debug,
            });
            rawTools[serverName] = response.tools;
          } else {
            log(`No client found for server ${serverName}`, undefined, {
              type: 'error',
              debug,
            });
          }

          // Get converted tools
          const tools = this.tools.get(serverName) || {};
          log(`Retrieved converted tools for ${serverName}:`, tools, { debug });
          Object.assign(allTools, tools);
        }
      } catch (error) {
        log(`Failed to get tools for server ${serverName}`, error, {
          type: 'error',
          debug,
        });
      }
    }

    // Create logs directory if it doesn't exist
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    log(`Final raw tools:`, rawTools, { debug });
    log(`Final converted tools:`, allTools, { debug });

    // Save raw MCP tools
    const rawToolsPath = path.join(logsDir, 'mcp-tools.json');
    fs.writeFileSync(rawToolsPath, JSON.stringify(rawTools, null, 2));
    log(`Saved raw MCP tools to ${rawToolsPath}`, undefined, { debug });

    // Save converted AI SDK tools
    const aiToolsPath = path.join(logsDir, 'ai-sdk-tools.json');
    fs.writeFileSync(aiToolsPath, JSON.stringify(allTools, null, 2));
    log(`Saved converted AI SDK tools to ${aiToolsPath}`, undefined, { debug });

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
}

// Export singleton instance
export const mcpService = MCPService.getInstance();
