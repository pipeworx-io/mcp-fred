# mcp-fred

FRED MCP — Federal Reserve Economic Data (St. Louis Fed)

Part of the [Pipeworx](https://pipeworx.io) open MCP gateway.

## Tools

| Tool | Description |
|------|-------------|

## Quick Start

Add to your MCP client config:

```json
{
  "mcpServers": {
    "fred": {
      "url": "https://gateway.pipeworx.io/fred/mcp"
    }
  }
}
```

Or use the CLI:

```bash
npx pipeworx use fred
```

## License

MIT
