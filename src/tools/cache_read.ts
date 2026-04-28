import { readFileSync, statSync } from "fs";
import { resolve } from "path";
import { hashContent, get, set } from "../cache.js";

export const cache_read_schema = {
  name: "cache_read",
  description:
    "Read a file with content-hash caching. Returns the cached result if the file hasn't changed since last read, avoiding redundant file reads that bloat context.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative path to the file to read",
      },
      max_lines: {
        type: "number",
        description: "Truncate output to this many lines (default: 500)",
      },
      project_root: {
        type: "string",
        description: "Project root for resolving relative paths",
      },
    },
    required: ["path"],
  },
} as const;

export async function cache_read(args: {
  path: string;
  max_lines?: number;
  project_root?: string;
}): Promise<string> {
  const absPath = resolve(args.project_root ?? process.cwd(), args.path);
  const maxLines = args.max_lines ?? 500;

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absPath);
  } catch {
    return `Error: file not found: ${absPath}`;
  }

  const cacheKey = `file:${absPath}`;
  const cached = get(cacheKey);

  // Read current file to get its hash
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch (e) {
    return `Error reading file: ${e}`;
  }

  const currentHash = hashContent(raw);

  // Cache hit: same content hash
  if (cached && cached.content_hash === currentHash) {
    return `[cached] ${cached.value}`;
  }

  // Cache miss or stale: process and store
  const lines = raw.split("\n");
  const truncated = lines.length > maxLines;
  const output = lines.slice(0, maxLines).join("\n");
  const summary = truncated
    ? `\n[truncated: showing ${maxLines}/${lines.length} lines]`
    : "";

  const result = output + summary;
  set(cacheKey, result, { contentHash: currentHash });

  return result;
}
