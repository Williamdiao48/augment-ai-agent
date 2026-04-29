import { readFileSync, statSync } from "fs";
import { resolve, basename } from "path";
import { hashContent, get, set } from "../cache.js";
import { hasBeenRead, recordRead } from "../indexer/db.js";

// ── Keyword excerpt ────────────────────────────────────────────────────────

function mergeWindows(windows: number[][]): number[][] {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1] + 1) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      merged.push(sorted[i]);
    }
  }
  return merged;
}

function keywordExcerpt(raw: string, file: string, keyword: string, contextLines: number): string {
  const lines = raw.split("\n");
  const re = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const matchIndices = lines.map((l, i) => re.test(l) ? i : -1).filter(i => i !== -1);

  if (matchIndices.length === 0) {
    const head = lines.slice(0, 50).join("\n");
    const suffix = lines.length > 50 ? `\n[... ${lines.length - 50} more lines]` : "";
    return `[augment-cc: no matches for "${keyword}" in ${file} — showing first 50 lines]\n\n${head}${suffix}`;
  }

  const windows = matchIndices.map(i => [
    Math.max(0, i - contextLines),
    Math.min(lines.length - 1, i + contextLines),
  ]);
  const merged = mergeWindows(windows);
  const shown = merged.slice(0, 10);
  const omitted = merged.length - shown.length;

  const sections = shown.map(([start, end]) =>
    lines.slice(start, end + 1)
      .map((line, offset) => `${start + offset + 1}: ${line}`)
      .join("\n")
  );

  const omittedNote = omitted > 0 ? ` — ${omitted} region(s) omitted` : "";
  const header = `[augment-cc: ${shown.length} match region(s) for "${keyword}" in ${file} (${matchIndices.length} match line(s))${omittedNote}]`;
  return `${header}\n\n${sections.join("\n\n---\n\n")}`;
}

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
  _sessionId?: string;
  keyword?: string;
  context_lines?: number;
}): Promise<string> {
  const absPath = resolve(args.project_root ?? process.cwd(), args.path);
  const maxLines = args.max_lines ?? 500;

  // Session-level dedup: skip disk read entirely if already in context
  if (args._sessionId) {
    const prior = hasBeenRead(args._sessionId, absPath);
    if (prior) {
      return `[augment-cc: ${basename(absPath)} already read this session — hash ${prior.content_hash.slice(0, 8)}. Content is already in your context; reading again wastes tokens.]`;
    }
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absPath);
  } catch {
    return `Error: file not found: ${absPath}`;
  }

  // Read current file
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch (e) {
    return `Error reading file: ${e}`;
  }

  // Keyword excerpt mode: return targeted search results, skip full-read cache and dedup recording
  if (args.keyword) {
    return keywordExcerpt(raw, basename(absPath), args.keyword, args.context_lines ?? 10);
  }

  const cacheKey = `file:${absPath}`;
  const cached = get(cacheKey);
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

  if (args._sessionId) recordRead(args._sessionId, absPath, currentHash);

  return result;
}
