# Contributing to AISDK MCP Bridge

First off, thank you for considering contributing to AISDK MCP Bridge! It's people like you that make this project better.

## Code of Conduct

This project and everyone participating in it is governed by our Code of Conduct. By participating, you are expected to uphold this code.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the existing issues to avoid duplicates. When you create a bug report, include as many details as possible:

- Use a clear and descriptive title
- Describe the exact steps to reproduce the problem
- Provide specific examples (e.g., sample code, configuration)
- Describe the behavior you observed and what you expected
- Include relevant logs from `logs/mcp-tools.log`
- Note your environment (Node.js version, OS, etc.)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion:

- Use a clear and descriptive title
- Provide a detailed description of the proposed functionality
- Explain why this enhancement would be useful
- List any alternatives you've considered

### Pull Requests

1. Fork the repo and create your branch from `main`
2. If you've added code that should be tested, add tests
3. Ensure the test suite passes
4. Make sure your code follows the existing style
5. Update the documentation if needed

## Development Process

1. **Setup Development Environment**

   ```bash
   git clone https://github.com/vrknetha/aisdk-mcp-bridge.git
   cd aisdk-mcp-bridge
   npm install
   ```

2. **Run Tests**

   ```bash
   npm test                # Run all tests
   npm run test:twitter   # Run Twitter MCP tests
   npm run test:firecrawl # Run Firecrawl tests
   ```

3. **Code Style**
   - Use TypeScript
   - Follow the existing code style
   - Use ESLint and Prettier for formatting
   ```bash
   npm run lint    # Check code style
   npm run format  # Format code
   ```

## Project Structure

```
aisdk-mcp-bridge/
├── src/
│   ├── index.ts         # Main entry point
│   ├── service.ts       # MCP service implementation
│   ├── server.ts        # Server management
│   └── tools.ts         # Utility functions
├── examples/
│   ├── test-twitter.ts  # Twitter MCP example
│   └── test-firecrawl.ts# Firecrawl example
├── tests/
│   └── ...             # Test files
└── logs/
    └── mcp-tools.log   # Debug and error logs
```

## Adding New MCP Servers

1. Create a new configuration in `mcp.config.json`:

   ```json
   {
     "mcpServers": {
       "your-server": {
         "command": "npx",
         "args": ["-y", "your-mcp-server"],
         "env": {
           "YOUR_API_KEY": "your-api-key"
         }
       }
     }
   }
   ```

2. Add tests in `examples/test-your-server.ts`
3. Update documentation to include your server
4. Add any necessary environment variables to `.env.example`

## Commit Messages

Format your commit messages according to conventional commits:

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `test:` Adding or updating tests
- `chore:` Maintenance tasks

Example:

```
feat: add support for new MCP server type

- Added configuration options for new server
- Implemented connection handling
- Added tests and documentation
```

## Release Process

1. Update version in `package.json`
2. Update CHANGELOG.md
3. Create a new release on GitHub
4. GitHub Actions will automatically publish to npm

## Getting Help

- Check the [documentation](README.md)
- Join our [Discord community](https://discord.gg/your-invite)
- Create an issue for complex questions

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
