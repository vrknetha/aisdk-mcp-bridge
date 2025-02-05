# AISDK MCP Bridge

A bridge package that enables seamless integration between the Model Context Protocol (MCP) and AI SDK, allowing for efficient communication and tool execution between MCP servers and AI models.

[![npm version](https://badge.fury.io/js/aisdk-mcp-bridge.svg)](https://badge.fury.io/js/aisdk-mcp-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- Seamless integration between MCP servers and AI SDK
- Support for various MCP server types (Node.js, Python, UVX)
- Multi-server support with independent configuration
- Flexible configuration through `mcp.config.json`
- TypeScript support with full type definitions
- Robust error handling and logging
- Easy-to-use API for tool execution

## Installation

```bash
npm install aisdk-mcp-bridge
```

## Quick Start

1. Create an `mcp.config.json` file in your project root:

```json
{
  "mcpServers": {
    "twitter-mcp": {
      "command": "npx",
      "args": ["-y", "@enescinar/twitter-mcp"],
      "env": {
        "API_KEY": "your-twitter-api-key",
        "API_SECRET_KEY": "your-twitter-api-secret",
        "ACCESS_TOKEN": "your-twitter-access-token",
        "ACCESS_TOKEN_SECRET": "your-twitter-access-token-secret"
      }
    },
    "firecrawl": {
      "command": "npx",
      "args": ["-y", "mcp-server-firecrawl"],
      "env": {
        "FIRE_CRAWL_API_KEY": "your-firecrawl-api-key",
        "FIRE_CRAWL_API_URL": "https://api.firecrawl.com"
      }
    }
  }
}
```

2. Import and use the bridge in your code:

```typescript
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { getMcpTools, cleanupMcp, initializeMcp } from 'aisdk-mcp-bridge';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  try {
    // Initialize MCP
    await initializeMcp({ debug: true });

    // Get tools from all servers
    const allTools = await getMcpTools({ debug: true });

    // Or get tools from a specific server
    const twitterTools = await getMcpTools({
      debug: true,
      serverName: 'twitter-mcp',
    });

    // Use tools with AI SDK
    const result = await generateText({
      model: google('gemini-1.5-pro'),
      messages: [
        {
          role: 'system',
          content:
            'You are an AI assistant that uses various tools to help users.',
        },
        {
          role: 'user',
          content: 'Your task description here',
        },
      ],
      tools: twitterTools, // or allTools for all available tools
    });

    console.log('Result:', result.text);
  } finally {
    // Clean up resources
    await cleanupMcp();
  }
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
```

## Configuration

The `mcp.config.json` file supports multiple servers and communication modes. Each server can be configured independently.

### Server Configuration Examples:

### Twitter MCP Server

```json
{
  "mcpServers": {
    "twitter-mcp": {
      "command": "npx",
      "args": ["-y", "@enescinar/twitter-mcp"],
      "env": {
        "API_KEY": "your-twitter-api-key",
        "API_SECRET_KEY": "your-twitter-api-secret",
        "ACCESS_TOKEN": "your-twitter-access-token",
        "ACCESS_TOKEN_SECRET": "your-twitter-access-token-secret"
      }
    }
  }
}
```

### Firecrawl Server

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "npx",
      "args": ["-y", "mcp-server-firecrawl"],
      "env": {
        "FIRE_CRAWL_API_KEY": "your-firecrawl-api-key",
        "FIRE_CRAWL_API_URL": "https://api.firecrawl.com"
      }
    }
  }
}
```

### SSE Server

```json
{
  "mcpServers": {
    "sse-server": {
      "command": "node",
      "args": ["./server.js"],
      "mode": "sse",
      "sseOptions": {
        "endpoint": "http://localhost:3000/events",
        "headers": {},
        "reconnectTimeout": 5000
      }
    }
  }
}
```

## Server Modes

The bridge supports different communication modes:

1. **stdio Mode** (Default)

   - Direct communication through standard input/output
   - Best for simple integrations and local development
   - Low latency and minimal setup required

2. **SSE Mode** (Server-Sent Events)
   - Real-time, one-way communication from server to client
   - Ideal for streaming updates and long-running operations
   - Built-in reconnection handling

## API Reference

### Core Functions

#### `initializeMcp(options?: InitOptions): Promise<void>`

Initialize the MCP service with the provided options.

```typescript
interface InitOptions {
  configPath?: string; // Path to mcp.config.json
  debug?: boolean; // Enable debug logging
}
```

#### `getMcpTools(options?: ToolOptions): Promise<ToolSet>`

Get AI SDK-compatible tools from MCP servers.

```typescript
interface ToolOptions {
  debug?: boolean; // Enable debug logging
  serverName?: string; // Optional server name to get tools from a specific server
}
```

#### `executeMcpFunction(serverName: string, functionName: string, args: Record<string, unknown>): Promise<MCPToolResult>`

Execute a specific function on an MCP server directly.

```typescript
// Example
const result = await executeMcpFunction('twitter-mcp', 'postTweet', {
  text: 'Hello from MCP!',
});
```

### Core Types

#### `MCPConfig` (alias for `MCPServersConfig`)

Configuration type for MCP servers.

```typescript
interface MCPConfig {
  mcpServers: {
    [key: string]: ServerConfig;
  };
}
```

#### `ServerConfig`

Configuration for individual MCP servers.

```typescript
interface ServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  mode?: 'stdio' | 'sse';
  sseOptions?: {
    endpoint: string;
    headers?: Record<string, string>;
    reconnectTimeout?: number;
  };
}
```

#### `MCPToolResult`

Result type for MCP tool executions.

```typescript
interface MCPToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}
```

#### `cleanupMcp(): Promise<void>`

Clean up MCP resources and close all server connections.

## Error Handling

The bridge includes comprehensive error handling for:

- Server initialization failures
- Communication errors
- Tool execution failures
- Configuration issues
- Server connection issues

## Logging

The bridge provides detailed logging through:

- `mcp-tools.log`: Server-side tool execution logs
- Console output for debugging and errors

### Debug Logging

You can enable detailed debug logging by setting the DEBUG environment variable:

```bash
# Enable all debug logs
DEBUG=* npm start

# Enable MCP debug logs
DEBUG=mcp npm start

# Enable all MCP namespace logs
DEBUG=mcp:* npm start
```

Debug logs will show:

- Server initialization and shutdown events
- Tool registration and execution details
- Communication with MCP servers
- Schema conversions and validations
- Error details with stack traces
- Performance metrics and timing information

### Log Types

The logging system supports three types of logs:

- `info`: General operational information
- `debug`: Detailed debugging information (requires DEBUG env variable)
- `error`: Error messages and stack traces (always logged)

### Log File

All logs are written to `logs/mcp-tools.log` with the following format:

```
[TIMESTAMP] [TYPE] Message
{Optional JSON data}
```

## Development

### Prerequisites

- Node.js 20.x or higher
- npm 7.x or higher

### Setup

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

### Testing

Run the test suite:

```bash
npm test
```

Run specific tests:

```bash

npm run test:twitter
npm run test:firecrawl
```

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details on:

- Setting up the development environment
- Coding standards
- Pull request process
- Adding new MCP servers

Please note that this project is released with a [Code of Conduct](CODE_OF_CONDUCT.md). By participating in this project you agree to abide by its terms.

## Support

For support:

1. Check the [documentation](README.md)
2. Search [existing issues](https://github.com/vrknetha/aisdk-mcp-bridge/issues)
3. Create a new issue if your problem persists

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a list of changes and migration guides.

## Security

For security issues, please email ravi@caw.tech instead of using the public issue tracker.

## Authors

- **Ravi Kiran** - _Initial work_ - [@vrknetha](https://github.com/vrknetha)

See also the list of [contributors](https://github.com/vrknetha/aisdk-mcp-bridge/contributors) who participated in this project.

## Acknowledgments

- AI SDK team for their excellent SDK
- MCP community for the protocol specification
- All contributors who have helped with the project

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
