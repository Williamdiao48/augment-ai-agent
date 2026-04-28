#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cache_read } from "./tools/cache_read.js";
import { shell_cached } from "./tools/shell_cached.js";
import { stats } from "./cache.js";

const server = new McpServer({
  name: "augment-cc",
  version: "0.1.0",
});

server.tool(
  "cache_read",
  "Read a file with content-hash caching. Returns cached result if file hasn't changed, avoiding redundant reads that bloat context.",
  {
    path: z.string().describe("Absolute or relative path to the file"),
    max_lines: z.number().optional().describe("Truncate to this many lines (default: 500)"),
    project_root: z.string().optional().describe("Project root for resolving relative paths"),
  },
  async (args) => ({
    content: [{ type: "text", text: await cache_read(args) }],
  })
);

server.tool(
  "shell_cached",
  "Run a read-only shell command with TTL-based caching. Returns cached output within TTL window. Use for git log/status, find, ls, npm list — never for commands with side effects.",
  {
    command: z.string().describe("Shell command to execute"),
    cwd: z.string().optional().describe("Working directory (default: cwd)"),
    ttl_ms: z.number().optional().describe("Cache TTL in ms (auto-detected by command pattern)"),
    max_output_chars: z.number().optional().describe("Truncate output to N chars (default: 8000)"),
  },
  async (args) => ({
    content: [{ type: "text", text: await shell_cached(args) }],
  })
);

server.tool(
  "cache_stats",
  "Report cache hit statistics and entry counts.",
  {},
  async () => {
    const s = stats();
    return {
      content: [
        {
          type: "text",
          text: `Cache entries: ${s.total} total, ${s.expired} expired (pending cleanup)`,
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP servers communicate over stdio — no console.log here
}

main().catch((e) => {
  process.stderr.write(`augment-cc fatal: ${e}\n`);
  process.exit(1);
});
