import { ToolSet } from 'ai';
import { MCPService, MCPToolResult } from './service';
import {
  MCPServerManager,
  type MCPServersConfig,
  type ServerConfig,
} from './server';
import { log } from './tools';
import path from 'path';
import fs from 'fs/promises';
import { z } from 'zod';
import { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';

// Core types
export type { MCPServersConfig as MCPConfig } from './server';
export type { ServerConfig } from './server';
export type { MCPToolResult } from './service';

// Configuration validation schema
const AutoApproveSchema = z.array(z.string()).default([]);

const ServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  mode: z.enum(['http', 'stdio', 'sse']).default('stdio'),
  env: z.record(z.string()).optional(),
  autoApprove: AutoApproveSchema.optional(),
  disabled: z.boolean().optional(),
  port: z.number().optional(),
  sseOptions: z
    .object({
      endpoint: z.string(),
      headers: z.record(z.string()).optional(),
      reconnectTimeout: z.number().optional(),
    })
    .optional(),
});

const MCPConfigSchema = z.object({
  mcpServers: z.record(ServerConfigSchema),
});

// Helper to convert ServerConfig to StdioServerParameters
export function toStdioParams(config: ServerConfig): StdioServerParameters {
  // Ensure PATH includes common binary locations
  const envPath = process.env.PATH || '';
  const additionalPaths = [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/homebrew/bin',
    './node_modules/.bin', // Add local node_modules bin
  ].join(':');

  return {
    command: config.command,
    args: config.args,
    env: {
      ...process.env, // Include all process environment variables
      NODE_ENV: process.env.NODE_ENV || 'development',
      PATH: `${envPath}:${additionalPaths}`, // Extend PATH with additional locations
      ...config.env, // Override with config environment variables
    },
    stderr: 'inherit',
  };
}

/**
 * Load MCP configuration from a JSON file
 */
async function loadMcpConfig(configPath: string): Promise<MCPServersConfig> {
  try {
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent);
    return MCPConfigSchema.parse(config);
  } catch (error) {
    log(`Failed to load config from ${configPath}`, error, { type: 'error' });
    throw error;
  }
}

/**
 * Save MCP configuration to a JSON file
 */
async function saveMcpConfig(
  config: MCPServersConfig,
  configPath: string
): Promise<void> {
  try {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    log('Saved MCP config', { path: configPath }, { type: 'debug' });
  } catch (error) {
    log(`Failed to save config to ${configPath}`, error, { type: 'error' });
    throw error;
  }
}

/**
 * Validate server configuration
 */
function validateServerConfig(config: ServerConfig): string[] {
  try {
    ServerConfigSchema.parse(config);
    return [];
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.errors.map(
        err => `${err.path.join('.')}: ${err.message}`
      );
      log('Server config validation failed', { errors }, { type: 'error' });
      return errors;
    }
    log('Invalid server configuration', error, { type: 'error' });
    return ['Invalid server configuration'];
  }
}

/**
 * Initialize MCP service with configuration
 */
export async function initializeMcp(
  options: {
    configPath?: string;
    debug?: boolean;
  } = {}
): Promise<void> {
  const { debug = false } = options;

  try {
    log('Starting MCP initialization...', undefined, { debug: true });

    // Load configuration
    const configPath =
      options.configPath || path.join(process.cwd(), 'mcp.config.json');
    log(
      'Loading config from default location',
      { path: configPath },
      { type: 'info' }
    );

    let config: MCPServersConfig;
    try {
      config = await loadMcpConfig(configPath);
      log('Loaded MCP configuration', config, { debug: true });
    } catch (error) {
      log(
        'No MCP configuration found. Please provide a valid mcp.config.json',
        error,
        { type: 'error' }
      );
      throw new Error(
        'MCP configuration is required. Please provide a valid mcp.config.json'
      );
    }

    // Initialize server manager
    const serverManager = MCPServerManager.getInstance();
    serverManager.setConfig(config);
    log('Server manager configured', undefined, { debug: true });

    // Initialize MCP service
    const service = MCPService.getInstance();
    await service.initialize({ debug });
    log('MCP initialization complete', undefined, { type: 'info' });
  } catch (error) {
    log('MCP initialization failed', error, { type: 'error' });
    throw error;
  }
}

/**
 * Get tools from MCP servers
 * @param options Configuration options
 * @param options.debug Enable debug logging
 * @param options.serverName Optional server name to get tools from a specific server
 * @returns Promise<ToolSet>
 */
export async function getMcpTools(
  options: {
    debug?: boolean;
    serverName?: string;
  } = {}
): Promise<ToolSet> {
  const { debug = false, serverName } = options;

  try {
    log('Getting MCP tools...', serverName ? { serverName } : undefined, {
      debug: true,
    });
    const service = MCPService.getInstance();

    if (!service.isInitialized()) {
      log('MCP not initialized, initializing now...', undefined, {
        debug: true,
      });
      await initializeMcp({ debug });
    }

    // Check if the specified server exists in configuration
    if (serverName) {
      const serverManager = MCPServerManager.getInstance();
      const config = serverManager.getConfig();
      if (!config?.mcpServers[serverName]) {
        const error = new Error(
          `Server "${serverName}" not found in configuration`
        );
        log(`Failed to get MCP tools: ${error.message}`, undefined, {
          type: 'error',
        });
        throw error;
      }
    }

    const tools = await service.getTools({ debug, serverName });
    log(
      `Retrieved MCP tools${serverName ? ` for server ${serverName}` : ' for all servers'}`,
      { toolCount: Object.keys(tools).length },
      { debug: true }
    );
    return tools;
  } catch (error) {
    log(
      `Failed to get MCP tools${serverName ? ` for server ${serverName}` : ''}`,
      error,
      { type: 'error' }
    );
    throw error;
  }
}

/**
 * Execute a specific function on an MCP server.
 *
 * @param serverName - Name of the server to execute on
 * @param functionName - Name of the function to execute
 * @param args - Arguments to pass to the function
 */
export async function executeMcpFunction(
  serverName: string,
  functionName: string,
  args: Record<string, unknown>
): Promise<MCPToolResult> {
  const service = MCPService.getInstance();
  return service.executeFunction(serverName, functionName, args);
}

/**
 * Clean up all MCP resources.
 * Should be called when shutting down the application.
 */
export async function cleanupMcp(): Promise<void> {
  const service = MCPService.getInstance();
  await service.cleanup();
}

// Export configuration types and utilities
export {
  ServerConfigSchema,
  MCPConfigSchema,
  loadMcpConfig,
  saveMcpConfig,
  validateServerConfig,
};

// Export singleton instances for advanced usage
export const mcpService = MCPService.getInstance();
