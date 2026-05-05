import { readFile } from "fs/promises";
import type { TranscriptFacts } from "./types.js";

// Skip read-only / diagnostic shell commands — they add no episodic value
const BASH_NOISE_RE =
  /^\s*(cat|head|tail|less|more|bat|echo|ls|pwd|which|file|stat)\b|^\s*git\s+(status|diff|log|show|branch|remote|fetch)\s*$|^\s*(find|grep|rg|fd)\s|^\s*node\s+--version\b|^\s*npm\s+(list|ls)\b/;

const DECISION_MARKERS = [
  "instead of", "rather than", "the reason", "we decided", "decided to",
  "alternative would be", "opted for", "chose to", "trade-off", "tradeoff",
];
const MAX_DECISIONS = 3;
const MAX_DECISION_LEN = 200;

function extractDecisionExcerpts(text: string, remaining: number): string[] {
  if (remaining <= 0) return [];
  const segments = text.replace(/\. (?=[A-Z])/g, ".\n").split(/\n+/);
  const found: string[] = [];
  for (const seg of segments) {
    if (found.length >= remaining) break;
    const trimmed = seg.trim();
    if (trimmed.length < 20) continue;
    const lower = trimmed.toLowerCase();
    if (DECISION_MARKERS.some(m => lower.includes(m))) {
      found.push(trimmed.slice(0, MAX_DECISION_LEN));
    }
  }
  return found;
}

function parseTimestamp(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const n = Date.parse(ts);
  return isNaN(n) ? null : n;
}

export async function parseTranscript(transcriptPath: string): Promise<TranscriptFacts | null> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf-8");
  } catch {
    return null;
  }

  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  const parsed: unknown[] = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  if (malformed > 0 && malformed > parsed.length) {
    process.stderr.write(`augment-cc [transcript]: majority of lines malformed in ${transcriptPath}\n`);
    return null;
  }

  let sessionId: string | null = null;
  let projectRoot: string | null = null;
  let branch = "HEAD";
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;
  let firstUserMessage: string | null = null;
  let lastAssistantText: string | null = null;
  const filesCreated = new Set<string>();
  const filesModified = new Set<string>();
  const commandsRun: string[] = [];
  let messageCount = 0;
  let aiTitle: string | null = null;
  const decisions: string[] = [];

  for (const obj of parsed) {
    if (typeof obj !== "object" || obj === null) continue;
    const e = obj as Record<string, unknown>;

    // Timestamps
    const ts = parseTimestamp(e["timestamp"]);
    if (ts !== null) {
      if (firstTimestamp === null) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    // Session metadata — capture once
    if (typeof e["sessionId"] === "string" && !sessionId) sessionId = e["sessionId"];
    if (typeof e["cwd"] === "string" && !projectRoot) projectRoot = e["cwd"];
    if (typeof e["gitBranch"] === "string" && e["gitBranch"] !== "HEAD") branch = e["gitBranch"];

    // ai-title entry
    if (e["type"] === "ai-title" && typeof e["aiTitle"] === "string") aiTitle = e["aiTitle"];

    // Skip infrastructure and sidechain entries
    if (e["type"] === "queue-operation") continue;
    if (e["isSidechain"] === true) continue;

    // User entries
    if (e["type"] === "user") {
      const content = ((e["message"] as Record<string, unknown>)?.["content"] ?? []) as unknown[];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b["type"] === "text" && typeof b["text"] === "string" && firstUserMessage === null) {
          firstUserMessage = b["text"].slice(0, 300);
        }
        // type === "tool_result" → skip (tool output, not user intent)
      }
    }

    // Assistant entries
    if (e["type"] === "assistant") {
      messageCount++;
      const content = ((e["message"] as Record<string, unknown>)?.["content"] ?? []) as unknown[];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b["type"] === "text" && typeof b["text"] === "string") {
          lastAssistantText = b["text"].slice(0, 400); // keep updating — last wins
          if (decisions.length < MAX_DECISIONS) {
            decisions.push(...extractDecisionExcerpts(b["text"], MAX_DECISIONS - decisions.length));
          }
        }
        if (b["type"] === "tool_use") {
          const name = b["name"] as string | undefined;
          const input = (b["input"] ?? {}) as Record<string, unknown>;
          if (name === "Write" && typeof input["file_path"] === "string") {
            filesCreated.add(input["file_path"]);
          }
          if (name === "Edit" && typeof input["file_path"] === "string") {
            filesModified.add(input["file_path"]);
          }
          if (name === "Bash" && typeof input["command"] === "string") {
            const cmd = input["command"].trim();
            if (!BASH_NOISE_RE.test(cmd) && commandsRun.length < 15) {
              commandsRun.push(cmd.slice(0, 120));
            }
          }
        }
      }
    }
  }

  if (!sessionId || !projectRoot || firstTimestamp === null || lastTimestamp === null) {
    return null;
  }

  // Write takes precedence over Edit for the same file
  const modifiedOnly = [...filesModified].filter(p => !filesCreated.has(p));

  return {
    sessionId,
    projectRoot,
    branch,
    startedAt: firstTimestamp,
    endedAt: lastTimestamp,
    durationSecs: Math.round((lastTimestamp - firstTimestamp) / 1000),
    firstUserMessage: firstUserMessage ?? "",
    lastAssistantText: lastAssistantText ?? "",
    filesCreated: [...filesCreated].sort(),
    filesModified: modifiedOnly.sort(),
    commandsRun,
    messageCount,
    aiTitle,
    decisions,
  };
}
