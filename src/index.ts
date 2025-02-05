import { ToolSet } from 'ai';
import { MCPService, MCPToolResult } from './service';
import {
  MCPServerManager,
  type MCPServersConfig,
  type ServerConfig,
  ServerConfigSchema,
  MCPServersConfigSchema,
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

// Helper to convert ServerConfig to StdioServerParameters (internal use only)
export function toStdioParams(config: ServerConfig): StdioServerParameters {
  // Ensure PATH includes common binary locations
  const envPath = process.env.PATH || '';
  const additionalPaths = [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/homebrew/bin',
    './node_modules/.bin',
  ].join(':');

  return {
    command: config.command,
    args: config.args,
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || 'development',
      PATH: `${envPath}:${additionalPaths}`,
      ...config.env,
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
    return MCPServersConfigSchema.parse(config);
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
 * Initialize MCP service
 */
export async function initializeMcp(
  options: {
    configPath?: string;
    debug?: boolean;
  } = {}
): Promise<void> {
  const { debug = false } = options;
  const service = MCPService.getInstance();

  // Check if already initialized
  if (service.isInitialized()) {
    log('MCP service already initialized', undefined, { debug });
    return;
  }

  log('Initializing MCP...', undefined, { debug: true });

  try {
    // Load configuration
    const configPath =
      options.configPath || path.join(process.cwd(), 'mcp.config.json');
    const config = await loadMcpConfig(configPath);
    log('Loaded MCP configuration', config, { debug });

    // Initialize server manager with config
    const serverManager = MCPServerManager.getInstance(config);

    // Initialize MCP service with server manager
    service.setServerManager(serverManager);

    // Start all servers
    const results = await serverManager.startAllServers();
    log('Server startup results:', results, { debug: true });

    // Check server statuses
    const failedServers = [];
    const runningServers = [];

    for (const [name, success] of results.entries()) {
      if (success) {
        runningServers.push(name);
        log(`Server ${name} started successfully`, undefined, { type: 'info' });
      } else {
        failedServers.push(name);
        log(`Server ${name} failed to start`, undefined, { type: 'error' });
      }
    }

    if (failedServers.length > 0) {
      log(
        `Some servers failed to start: ${failedServers.join(', ')}`,
        undefined,
        {
          type: 'error',
        }
      );
    }

    if (runningServers.length === 0) {
      throw new Error('No servers started successfully');
    }

    // Mark service as initialized since we have at least one working server
    await service.initialize({ debug });
    log(
      `MCP service initialized with servers: ${runningServers.join(', ')}`,
      undefined,
      {
        type: 'info',
      }
    );
  } catch (error) {
    log('Failed to initialize MCP', error, { type: 'error' });
    await service.cleanup(); // Clean up on initialization failure
    throw error;
  }
}

/**
 * Get tools from MCP servers
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
      log('MCP service not initialized', undefined, { type: 'error' });
      throw new Error(
        'MCP service not initialized. Call initializeMcp() first.'
      );
    }

    // Check if the specified server exists in configuration
    if (serverName) {
      const serverManager = MCPServerManager.getInstance(service.getConfig());
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
 * Clean up MCP resources
 */
export async function cleanupMcp(): Promise<void> {
  try {
    log('Cleaning up MCP resources...', undefined, { debug: true });
    const service = MCPService.getInstance();

    let cleanupComplete = false;
    const cleanupTimeout = setTimeout(() => {
      if (!cleanupComplete) {
        log('Cleanup timeout reached, forcing exit...', undefined, {
          type: 'error',
        });
        process.exit(1);
      }
    }, 15000);

    try {
      await service.cleanup();
      log('MCP cleanup complete', undefined, { debug: true });

      // Clear any remaining intervals/timeouts
      const intervalIds = getIntervalIds();
      intervalIds.forEach(clearInterval);
      const timeoutIds = getTimeoutIds();
      timeoutIds.forEach(clearTimeout);

      cleanupComplete = true;
      clearTimeout(cleanupTimeout);

      // Give a small delay for final cleanup operations
      await new Promise(resolve => setTimeout(resolve, 1000));
      process.exit(0);
    } catch (error) {
      log('Cleanup failed', error, { type: 'error' });
      process.exit(1);
    }
  } catch (error) {
    log('Failed to clean up MCP resources', error, { type: 'error' });
    process.exit(1);
  }
}

// Helper function to get all active interval IDs
function getIntervalIds(): NodeJS.Timeout[] {
  const ids: NodeJS.Timeout[] = [];
  const originalSetInterval = global.setInterval;
  global.setInterval = function (
    callback: () => void,
    ms?: number
  ): NodeJS.Timeout {
    const id = originalSetInterval(callback, ms);
    ids.push(id);
    return id;
  } as typeof global.setInterval;
  return ids;
}

// Helper function to get all active timeout IDs
function getTimeoutIds(): NodeJS.Timeout[] {
  const ids: NodeJS.Timeout[] = [];
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = function (
    callback: () => void,
    ms?: number
  ): NodeJS.Timeout {
    const id = originalSetTimeout(callback, ms);
    ids.push(id);
    return id;
  } as typeof global.setTimeout;
  return ids;
}

// Export configuration types and utilities
export {
  ServerConfigSchema,
  MCPServersConfigSchema,
  loadMcpConfig,
  saveMcpConfig,
  validateServerConfig,
};

// Export singleton instances for advanced usage
export const mcpService = MCPService.getInstance();
