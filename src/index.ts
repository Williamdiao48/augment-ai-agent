#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cache_read } from "./tools/search_file.js";
import { bash_exec } from "./tools/bash_exec.js";
import { run_saved_command } from "./tools/run_saved_command.js";
import { list_commands } from "./tools/list_commands.js";
import { write_handoff } from "./tools/write_handoff.js";
import { stats as _stats } from "./cache.js";
import { IndexerService, getProjectIndex } from "./indexer/index.js";
import { getGitState, formatGitState } from "./indexer/git.js";
import { initIndexDb, pruneOldSessionReads, pruneOldCommandRuns, deleteCommand } from "./indexer/db.js";

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
  "bash",
  "Run a shell command with output filtering (ANSI stripping, npm noise removal) and optional script saving. Pass save_as to upsert a named script for reuse. Pass filter: false for raw output.",
  {
    command: z.string().describe("Shell command to execute"),
    filter: z.boolean().optional().describe("Apply ANSI stripping and package manager noise filtering (default: true). Pass false for raw output."),
    max_output: z.number().optional().describe("Truncate output to this many characters (default: 8000)"),
    save_as: z.string().optional().describe("Save this command under a short name for reuse (upserts — overwrites if name exists). Use snake_case."),
    description: z.string().optional().describe("One-line description for the saved script (used with save_as)"),
    cwd: z.string().optional().describe("Working directory (default: process.cwd())"),
  },
  async (args) => ({
    content: [{ type: "text", text: await bash_exec({ ...args, _projectRoot: process.cwd() }) }],
  })
);

server.tool(
  "run_saved_command",
  "Run a previously saved project script by name. Use list_commands() to see available scripts. Always returns live output.",
  {
    name: z.string().describe("Name of the saved command to run"),
    cwd: z.string().optional().describe("Working directory (default: project root)"),
    max_output_chars: z.number().optional().describe("Truncate output to N chars (default: 8000)"),
  },
  async (args) => ({
    content: [{ type: "text", text: await run_saved_command({ ...args, _projectRoot: process.cwd() }) }],
  })
);

server.tool(
  "list_commands",
  "List all saved scripts and frequently-run commands for this project. Shows last_failed_at for scripts that have failed.",
  {},
  async () => ({
    content: [{ type: "text", text: await list_commands({ _projectRoot: process.cwd() }) }],
  })
);

server.tool(
  "delete_command",
  "Delete a saved script by name.",
  {
    name: z.string().describe("Name of the saved command to delete"),
  },
  async ({ name }) => {
    const removed = deleteCommand(process.cwd(), name);
    const msg = removed
      ? `[augment-cc: deleted command "${name}"]`
      : `[augment-cc: no saved command "${name}" found]`;
    return { content: [{ type: "text", text: msg }] };
  }
);

server.tool(
  "write_handoff",
  "Save a forward-looking handoff note for the next session — what's in progress, what's next, decisions made, failed approaches to avoid. Called when you want to explicitly prepare context for the next session. Auto-generated at session end if not called.",
  {
    content: z.string().describe("3-5 sentence handoff note. Cover: what task is in progress, what's partially done or broken, what the next step is, decisions made and why, any failed approaches to avoid. Do not describe project structure or schemas — those are already available."),
  },
  async ({ content }) => ({
    content: [{ type: "text", text: await write_handoff({ content, _projectRoot: process.cwd() }) }],
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
