import { readFileSync, statSync } from "fs";
import { resolve, basename } from "path";
import { createPatch } from "diff";
import { hashContent, get, set } from "../cache.js";
import { hasBeenRead, recordRead, refreshSessionHash, resetSessionReadBaseline, getLastCompaction } from "../indexer/db.js";

// ── Diff helper ───────────────────────────────────────────────────────────

const MAX_DIFF_LINES = 150;
const COMPACTION_AGE_MS = Number(process.env.AUGMENT_CC_COMPACTION_AGE_MS ?? 15 * 60 * 1000);

function computeDiff(oldContent: string, newContent: string, filename: string): string {
  const patch = createPatch(filename, oldContent, newContent, "", "");
  const lines = patch.split("\n").slice(4); // strip unified diff file header
  if (lines.length <= MAX_DIFF_LINES) return lines.join("\n");
  return (
    lines.slice(0, MAX_DIFF_LINES).join("\n") +
    `\n[diff truncated — ${lines.length - MAX_DIFF_LINES} more lines. File changed substantially; request a full re-read if needed.]`
  );
}

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

  const DENSE_THRESHOLD = 0.20;
  const MAX_REGIONS = 10;
  const isDense = matchIndices.length > 1 && merged.length < matchIndices.length * DENSE_THRESHOLD;

  let shown: number[][];
  let header: string;

  if (isDense) {
    const step = Math.ceil(matchIndices.length / MAX_REGIONS);
    const sampledIndices = matchIndices.filter((_, i) => i % step === 0);
    const sampledWindows = sampledIndices.map(i => [
      Math.max(0, i - contextLines),
      Math.min(lines.length - 1, i + contextLines),
    ]);
    shown = mergeWindows(sampledWindows).slice(0, MAX_REGIONS);
    const density = Math.round(lines.length / matchIndices.length);
    header = `[augment-cc: "${keyword}" is dense in ${file} — ${matchIndices.length} match line(s) in ${lines.length} lines (~1 in every ${density}). Showing ${shown.length} sampled region(s)]`;
  } else {
    shown = merged.slice(0, MAX_REGIONS);
    const omitted = merged.length - shown.length;
    const omittedNote = omitted > 0 ? ` — ${omitted} region(s) omitted` : "";
    header = `[augment-cc: ${shown.length} match region(s) for "${keyword}" in ${file} (${matchIndices.length} match line(s))${omittedNote}]`;
  }

  const sections = shown.map(([start, end]) =>
    lines.slice(start, end + 1)
      .map((line, offset) => `${start + offset + 1}: ${line}`)
      .join("\n")
  );

  return `${header}\n\n${sections.join("\n\n---\n\n")}`;
}

function lineSlice(allLines: string[], offset: number, limit: number | undefined, file: string): string {
  const total = allLines.length;
  const start = Math.min(offset, total);
  const end = limit !== undefined ? Math.min(start + limit, total) : total;

  if (start >= total) {
    return `[augment-cc: offset ${offset} is beyond end of ${file} (${total} lines)]`;
  }

  const header = `[augment-cc: lines ${start + 1}–${end} of ${file} (${total} total lines)]`;
  const numbered = allLines.slice(start, end).map((line, i) => `${start + i + 1}: ${line}`).join("\n");
  return `${header}\n\n${numbered}`;
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
      force: {
        type: "boolean",
        description: "Re-inject full file content even if already read this session. Use when you know context was compacted and you need to recover the file.",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from, 0-based (default: 0). Use with limit for targeted reads.",
      },
      limit: {
        type: "number",
        description: "Number of lines to return (default: read to end of file).",
      },
    },
    required: ["path"],
  },
} as const;

export async function cache_read(args: {
  path: string;
  max_lines?: number;
  project_root?: string;
  offset?: number;
  limit?: number;
  _sessionId?: string;
  keyword?: string;
  context_lines?: number;
  force?: boolean;
  _samplingFn?: (prompt: string) => Promise<string>;
}): Promise<string> {
  const absPath = resolve(args.project_root ?? process.cwd(), args.path);
  const maxLines = args.max_lines ?? 500;
  const hasRange = args.offset !== undefined || args.limit !== undefined;

  // Session-level dedup + diff-based change detection (skipped for offset/limit reads)
  if (args._sessionId && !hasRange) {
    const prior = hasBeenRead(args._sessionId, absPath);
    if (prior) {
      recordRead(args._sessionId, absPath, prior.content_hash);

      // Detect whether compaction has occurred since this file was last read
      let compactedAway = false;
      if (!args.force && args.project_root) {
        const lastCompaction = getLastCompaction(resolve(args.project_root));
        if (lastCompaction !== null && prior.first_read_at < lastCompaction) {
          compactedAway = true;
        }
      }

      if (!args.force && !compactedAway) {
        const ageMs = Date.now() - prior.first_read_at;
        const ageStr = ageMs < 60_000
          ? `${Math.round(ageMs / 1000)}s ago`
          : `${Math.round(ageMs / 60_000)}m ago`;

        // Fast path: too recent for compaction — stub without sampling
        if (ageMs < COMPACTION_AGE_MS || !args._samplingFn) {
          const hint = ageMs >= COMPACTION_AGE_MS
            ? " — sampling unavailable; use force: true if compacted"
            : " — use force: true if compacted";
          return `[augment-cc: ${basename(absPath)} already read this session (${ageStr})${hint}]`;
        }

        // Slow path: age exceeds threshold — ask Claude if content is still in context
        let inContext = true;
        try {
          const answer = await args._samplingFn(
            `Does your current context window contain the full content of the file '${basename(absPath)}'? Answer only YES or NO.`
          );
          inContext = !answer.trim().toUpperCase().startsWith("N");
        } catch {
          // sampling failed — assume in context (safe fallback, avoids unnecessary re-inject)
        }

        if (inContext) {
          return `[augment-cc: ${basename(absPath)} already read this session (${ageStr}, confirmed in context)]`;
        }
        // Claude confirmed content is gone — fall through to re-read below
      }

      // Re-read path: force: true OR sampling confirmed content is gone
      const cacheKey = `file:${absPath}`;
      const cached = get(cacheKey);

      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(absPath);
      } catch {
        return `[augment-cc: ${basename(absPath)} was read this session but can no longer be found — it may have been deleted or moved.]`;
      }

      const currentMtime = Math.floor(stat.mtimeMs);

      // File unchanged — return cached content directly
      if (cached && cached.file_mtime !== null && cached.file_mtime === currentMtime) {
        if (compactedAway) resetSessionReadBaseline(args._sessionId, absPath);
        return `[augment-cc: re-injecting ${basename(absPath)} (file unchanged)]\n\n${cached.value}`;
      }

      // mtime changed → read current file
      let newRaw: string;
      try {
        newRaw = readFileSync(absPath, "utf-8");
      } catch (e) {
        return `Error reading file: ${e}`;
      }

      const newHash = hashContent(newRaw);

      // Hash same → cosmetic write → update mtime, return cached content
      if (newHash === prior.content_hash) {
        if (cached) set(cacheKey, cached.value, { contentHash: newHash, fileMtime: currentMtime });
        if (compactedAway) resetSessionReadBaseline(args._sessionId, absPath);
        return `[augment-cc: re-injecting ${basename(absPath)} (file unchanged)]\n\n${cached?.value ?? ""}`;
      }

      // Content changed → update cache, return diff
      const oldContent = cached?.value ?? "";
      const newLines = newRaw.split("\n");
      const truncated = newLines.length > maxLines;
      const newContent =
        newLines.slice(0, maxLines).join("\n") +
        (truncated ? `\n[truncated: showing ${maxLines}/${newLines.length} lines]` : "");

      set(cacheKey, newContent, { contentHash: newHash, fileMtime: currentMtime });
      refreshSessionHash(args._sessionId, absPath, newHash);

      // Compacted away + file changed: return full content (diff is useless without the "before" state)
      if (compactedAway) {
        resetSessionReadBaseline(args._sessionId, absPath);
        return `[augment-cc: re-injecting ${basename(absPath)} (modified since last read)]\n\n${newContent}`;
      }

      const diffText = computeDiff(oldContent, newContent, basename(absPath));
      return `[augment-cc: ${basename(absPath)} was modified since last read — showing diff]\n\n${diffText}`;
    }
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absPath);
  } catch {
    return `Error: file not found: ${absPath}`;
  }

  const cacheKey = `file:${absPath}`;
  const cached = get(cacheKey);
  const currentMtime = Math.floor(stat.mtimeMs);

  // mtime fast-path: skip readFileSync if mtime unchanged (not applicable to keyword or hasRange mode)
  if (!args.keyword && !hasRange && cached && cached.file_mtime !== null && cached.file_mtime === currentMtime) {
    if (args._sessionId) recordRead(args._sessionId, absPath, cached.content_hash ?? "");
    return `[cached] ${cached.value}`;
  }

  // Read current file
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch (e) {
    return `Error reading file: ${e}`;
  }

  // Offset/limit mode: slice raw content, register read, return immediately
  if (hasRange) {
    const allLines = raw.split("\n");
    const currentHash = hashContent(raw);
    if (args._sessionId) recordRead(args._sessionId, absPath, currentHash);
    return lineSlice(allLines, args.offset ?? 0, args.limit, basename(absPath));
  }

  // Keyword excerpt mode: return targeted search results, skip full-read cache and dedup recording
  if (args.keyword) {
    return keywordExcerpt(raw, basename(absPath), args.keyword, args.context_lines ?? 10);
  }

  const currentHash = hashContent(raw);

  // Cache hit: same content hash (mtime changed but content identical — e.g. touch)
  if (cached && cached.content_hash === currentHash) {
    set(cacheKey, cached.value, { contentHash: currentHash, fileMtime: currentMtime });
    if (args._sessionId) recordRead(args._sessionId, absPath, currentHash);
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
  set(cacheKey, result, { contentHash: currentHash, fileMtime: currentMtime });

  if (args._sessionId) recordRead(args._sessionId, absPath, currentHash);

  return result;
}
