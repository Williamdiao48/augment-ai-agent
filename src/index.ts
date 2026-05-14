#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cache_read } from "./tools/search_file.js";
import { shell_cached } from "./tools/shell_cached.js";
import { run_saved_command } from "./tools/run_saved_command.js";
import { stats as _stats } from "./cache.js";
import { IndexerService, getProjectIndex } from "./indexer/index.js";
import { getGitState, formatGitState } from "./indexer/git.js";
import { initIndexDb, pruneOldSessionReads, pruneOldCommandRuns, saveCommand } from "./indexer/db.js";

const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const server = new McpServer({
  name: "augment-cc",
  version: "0.1.0",
});

server.tool(
  "search_file",
  "Search a file by keyword — returns the matching section with line numbers. Use for locating functions or symbols before editing.",
  {
    path: z.string().describe("Absolute or relative path to the file"),
    max_lines: z.number().optional().describe("Truncate to this many lines (default: 500). Ignored when keyword is set."),
    project_root: z.string().optional().describe("Project root for resolving relative paths"),
    keyword: z.string().optional().describe("Return only lines containing this term plus surrounding context. Use when you know what you're looking for — saves context vs reading the full file."),
    context_lines: z.number().optional().describe("Lines of context around each keyword match (default: 10)"),
    force: z.boolean().optional().describe("Re-inject full file content even if already read this session. Use when you know context was compacted and you need to recover the file."),
    offset: z.number().optional().describe("Line number to start reading from, 0-based (default: 0). Use with limit for targeted reads before Edit/Write."),
    limit: z.number().optional().describe("Number of lines to return (default: read to end of file). Use with offset for targeted reads."),
  },
  async (args) => {
    let samplingFn: ((prompt: string) => Promise<string>) | undefined;
    if (server.server.getClientCapabilities()?.sampling) {
      samplingFn = async (prompt: string) => {
        const result = await server.server.createMessage({
          messages: [{ role: "user", content: { type: "text", text: prompt } }],
          maxTokens: 5,
        });
        return result.content.type === "text" ? result.content.text : "";
      };
    }
    return {
      content: [{ type: "text", text: await cache_read({ ...args, _sessionId: SESSION_ID, _samplingFn: samplingFn }) }],
    };
  }
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
    content: [{ type: "text", text: await shell_cached({ ...args, _projectRoot: process.cwd() }) }],
  })
);

server.tool(
  "save_command",
  "Save a bash script under a short name for quick reuse across sessions. Saved commands appear in the Script Library section of the project index at every session start and can be run instantly with run_saved_command.",
  {
    name: z.string().describe("Short identifier for this script (e.g. 'git_recent', 'run_tests'). Use snake_case."),
    script: z.string().describe("The bash script or command to save"),
    description: z.string().describe("One-line description of what this script does"),
  },
  async (args) => {
    saveCommand(process.cwd(), args.name, args.script, args.description);
    return {
      content: [{ type: "text", text: `[augment-cc: saved command "${args.name}" — available immediately via run_saved_command("${args.name}") and will appear in the Script Library at next session start]` }],
    };
  }
);

server.tool(
  "run_saved_command",
  "Run a previously saved project script by name. Scripts are listed in the Script Library section of the project index. Always returns live output (no TTL caching).",
  {
    name: z.string().describe("Name of the saved command to run"),
    cwd: z.string().optional().describe("Working directory (default: project root)"),
    max_output_chars: z.number().optional().describe("Truncate output to N chars (default: 8000)"),
  },
  async (args) => ({
    content: [{ type: "text", text: await run_saved_command({ ...args, _projectRoot: process.cwd() }) }],
  })
);

server.resource(
  "project-index",
  "project://index",
  {
    description:
      "Compressed structural index of the current project: DB schema, API routes, TypeScript types, env vars, Docker services, and file tree. Built on server startup and updated incrementally via file watcher. Always includes live git state (branch, recent commits, modified files).",
    mimeType: "text/markdown",
  },
  async (_uri) => {
    const git = getGitState(process.cwd());
    const indexMd = await getProjectIndex(process.cwd());
    const gitBlock = formatGitState(git);
    const text = [gitBlock, indexMd].filter(Boolean).join("\n\n")
      || "<!-- Project index not yet built — retry in a moment -->";
    return {
      contents: [{ uri: "project://index", mimeType: "text/markdown", text }],
    };
  }
);

async function main() {
  if (process.argv[2]) {
    const { runCli } = await import("./cli.js");
    await runCli(process.argv);
    process.exit(0);
  }

  initIndexDb();
  pruneOldSessionReads();
  pruneOldCommandRuns();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  new IndexerService(process.cwd()).start().catch((e) => {
    process.stderr.write(`augment-cc indexer error: ${e}\n`);
  });
}

main().catch((e) => {
  process.stderr.write(`augment-cc fatal: ${e}\n`);
  process.exit(1);
});
