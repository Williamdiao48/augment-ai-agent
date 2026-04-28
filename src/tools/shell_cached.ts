import { execSync } from "child_process";
import { get, set } from "../cache.js";

// TTL presets for common command patterns (ms)
const TTL_PRESETS: Array<[RegExp, number]> = [
  [/^git\s+log/, 30_000],          // git log: 30s
  [/^git\s+status/, 10_000],        // git status: 10s
  [/^git\s+diff/, 10_000],          // git diff: 10s
  [/^(npm|yarn|pnpm)\s+list/, 300_000], // package list: 5min
  [/^(cat|head|tail)\s+/, 0],       // file reads: no TTL (use cache_read instead)
  [/^find\s+/, 60_000],             // find: 1min
  [/^ls\s+/, 30_000],               // ls: 30s
];

const DEFAULT_TTL_MS = 60_000; // 1 minute default

function getTtl(command: string, overrideTtlMs?: number): number {
  if (overrideTtlMs !== undefined) return overrideTtlMs;
  for (const [pattern, ttl] of TTL_PRESETS) {
    if (pattern.test(command.trim())) return ttl;
  }
  return DEFAULT_TTL_MS;
}

export const shell_cached_schema = {
  name: "shell_cached",
  description:
    "Run a shell command with TTL-based caching. Identical commands return cached output within the TTL window, preventing redundant subprocess spawns that waste context tokens. Use for read-only commands (git log, find, ls, npm list). Never use for commands with side effects.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute",
      },
      cwd: {
        type: "string",
        description: "Working directory for the command (default: process.cwd())",
      },
      ttl_ms: {
        type: "number",
        description:
          "Cache TTL in milliseconds. Defaults to a preset based on command pattern (e.g. 30s for git log, 1min for find).",
      },
      max_output_chars: {
        type: "number",
        description: "Truncate output to this many characters (default: 8000)",
      },
    },
    required: ["command"],
  },
} as const;

export async function shell_cached(args: {
  command: string;
  cwd?: string;
  ttl_ms?: number;
  max_output_chars?: number;
}): Promise<string> {
  const cwd = args.cwd ?? process.cwd();
  const maxChars = args.max_output_chars ?? 8_000;
  const ttlMs = getTtl(args.command, args.ttl_ms);

  // 0 TTL = no caching (e.g. file-read commands redirected here)
  const cacheKey = `shell:${cwd}:${args.command}`;

  if (ttlMs > 0) {
    const cached = get(cacheKey);
    if (cached) return `[cached] ${cached.value}`;
  }

  let output: string;
  try {
    output = execSync(args.command, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    output = err.stdout ?? err.stderr ?? err.message ?? String(e);
  }

  const truncated = output.length > maxChars;
  const result = truncated
    ? output.slice(0, maxChars) + `\n[truncated: ${output.length} chars total]`
    : output;

  if (ttlMs > 0) {
    set(cacheKey, result, { ttlMs });
  }

  return result;
}
