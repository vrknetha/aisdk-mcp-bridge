# AISDK MCP Bridge

A bridge package that enables seamless integration between the Model Context Protocol (MCP) and AI SDK, allowing for efficient communication and tool execution between MCP servers and AI models.

[![npm version](https://badge.fury.io/js/aisdk-mcp-bridge.svg)](https://badge.fury.io/js/aisdk-mcp-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- Seamless integration between MCP servers and AI SDK
- Support for various MCP server types (Node.js, Python, UVX)
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
  "command": "npx",
  "args": ["mcp-server-firecrawl"],
  "mode": "stdio",
  "env": {
    "NODE_ENV": "development",
    "API_KEY": "your-api-key"
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
    const serverTools = await getMcpTools({
      debug: true,
      serverName: 'my-server',
    });

    // Use tools with AI SDK
    const result = await generateText({
      model: google('gemini-1.5-pro'),
      prompt: 'Your prompt here',
      tools: allTools, // or serverTools
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

The `mcp.config.json` file supports various server types and communication modes. The mode is optional and defaults to 'stdio' if not specified.

### Server Modes

The bridge supports three different communication modes:

1. **stdio Mode** (Default)

   - Direct communication through standard input/output
   - Best for simple integrations and local development
   - Low latency and minimal setup required
   - Default mode when no mode is specified

2. **HTTP Mode**

   - RESTful communication over HTTP
   - Suitable for distributed systems and microservices
   - Supports load balancing and horizontal scaling
   - Requires port configuration

3. **SSE Mode** (Server-Sent Events)
   - Real-time, one-way communication from server to client
   - Ideal for streaming updates and long-running operations
   - Built-in reconnection handling
   - Requires endpoint configuration

### Server Configuration Examples:

### Basic Server (using default stdio mode)

```json
{
  "command": "npx",
  "args": ["your-mcp-server"],
  "env": {
    "NODE_ENV": "development"
  }
}
```

### NPX-based Server (explicit stdio mode)

```json
{
  "command": "npx",
  "args": ["your-mcp-server"],
  "mode": "stdio",
  "env": {
    "NODE_ENV": "development"
  }
}
```

### Node-based Server

```json
{
  "command": "node",
  "args": ["./path/to/your/server.js"],
  "mode": "stdio",
  "env": {
    "NODE_ENV": "development"
  }
}
```

### HTTP Server

```json
{
  "command": "node",
  "args": ["./server.js"],
  "mode": "http",
  "port": 3000,
  "env": {
    "NODE_ENV": "development"
  }
}
```

### SSE (Server-Sent Events) Server

```json
{
  "command": "uvx",
  "args": ["run", "server"],
  "mode": "sse",
  "sseOptions": {
    "endpoint": "http://localhost:3000/events",
    "headers": {},
    "reconnectTimeout": 5000
  },
  "env": {
    "NODE_ENV": "development"
  }
}
```

### Python/UVX-based Server

```json
{
  "command": "python",
  "args": ["./path/to/your/server.py"],
  "mode": "stdio",
  "env": {
    "PYTHONPATH": "./path/to/python/modules"
  }
}
```

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

#### `cleanupMcp(): Promise<void>`

Clean up MCP resources and close all server connections.

### Error Handling

The bridge includes comprehensive error handling for common scenarios:

- Server initialization failures
- Communication errors
- Tool execution failures
- Configuration issues
- Invalid server names
- Server connection issues

Errors are properly typed and include detailed messages to help with debugging. When using `getMcpTools` with a specific server name, it will throw an error if:

- The server is not found in the configuration
- The server is disabled
- The server failed to initialize
- The server is not running

## Logging

The bridge provides detailed logging through the following files:

- `mcp-tools.log`: Server-side tool execution logs
- `ai-sdk-tools.json`: AI SDK integration logs
- `mcp-tools.json`: MCP server state and communication logs

## Development

### Prerequisites

- Node.js 16.x or higher
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
npm run test:mcp
```

### Building

Build the package:

```bash
npm run build
```

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For support, please:

1. Check the [documentation](docs/)
2. Search for existing [issues](https://github.com/yourusername/aisdk-mcp-bridge/issues)
3. Create a new issue if your problem persists

## Acknowledgments

- AI SDK team for their excellent SDK
- MCP community for the protocol specification
- All contributors who have helped with the project
