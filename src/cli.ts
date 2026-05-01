import { resolve, join } from "path";
import os from "os";
import { initIndexDb, getStoredIndex, getRecentSessions, saveSession, getTopReadFiles } from "./indexer/db.js";
import { getGitState, formatGitState } from "./indexer/git.js";
import { rebuildProjectIndex } from "./indexer/index.js";
import { parseTranscript } from "./indexer/transcript.js";
import type { ProjectIndex, TranscriptFacts, SessionEntry } from "./indexer/types.js";

const STALE_MS = Number(process.env.AUGMENT_CC_STALE_MS ?? 3_600_000);

// ── helpers ────────────────────────────────────────────────────────────────

function parseProjectRoot(argv: string[]): string {
  const idx = argv.indexOf("--project-root");
  return idx !== -1 && argv[idx + 1] ? resolve(argv[idx + 1]) : process.cwd();
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── quality gate ───────────────────────────────────────────────────────────

function meetsQualityThreshold(facts: TranscriptFacts): boolean {
  if (facts.durationSecs < 60) return false;
  if (facts.messageCount < 2) return false;
  if (facts.filesCreated.length + facts.filesModified.length + facts.commandsRun.length < 1) return false;
  if (!facts.firstUserMessage) return false;
  return true;
}

// ── summarization ──────────────────────────────────────────────────────────

function buildStructuredSummary(facts: TranscriptFacts): string {
  const parts: string[] = [];
  parts.push(`${formatDuration(facts.durationSecs)} on \`${facts.branch}\`.`);
  if (facts.firstUserMessage)
    parts.push(`Task: "${facts.firstUserMessage.slice(0, 200)}"`);
  const allFiles = [...facts.filesCreated, ...facts.filesModified];
  if (allFiles.length > 0) {
    const names = allFiles.slice(0, 10).map(f => f.split("/").pop()).join(", ");
    const rest = allFiles.length > 10 ? ` [+${allFiles.length - 10} more]` : "";
    parts.push(`Changed: ${names}${rest}.`);
  }
  if (facts.commandsRun.length > 0)
    parts.push(`Commands: ${facts.commandsRun.slice(0, 5).join("; ")}.`);
  if (facts.lastAssistantText)
    parts.push(`Concluded: "${facts.lastAssistantText.slice(0, 250)}"`);
  return parts.join(" ");
}

// ── high-value files formatter ─────────────────────────────────────────────

function formatHighValueFiles(files: Array<{ file_path: string; session_count: number; total_reads: number }>): string | null {
  if (files.length === 0) return null;
  const lines = ["## High-value Files (historically frequent reads)", ""];
  for (const f of files) {
    const name = f.file_path.split("/").pop() ?? f.file_path;
    const sessPlural = f.session_count === 1 ? "session" : "sessions";
    lines.push(`- \`${name}\` — read in ${f.session_count} ${sessPlural}, ${f.total_reads} total reads`);
    lines.push(`  Path: ${f.file_path}`);
  }
  lines.push("");
  lines.push("Consider reading these early and keeping their key details in mind — compaction is more likely to drop them.");
  return lines.join("\n");
}

// ── session formatter ──────────────────────────────────────────────────────

function formatSessions(sessions: SessionEntry[]): string | null {
  if (sessions.length === 0) return null;

  const lines: string[] = ["## Recent Sessions", ""];
  for (const s of sessions) {
    const date = new Date(s.startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const dur = formatDuration(s.durationSecs);
    const titlePart = s.aiTitle ? ` — ${s.aiTitle}` : "";
    lines.push(`### ${date} (${dur} on \`${s.branch}\`)${titlePart}`);
    lines.push(s.summary);
    const allFiles = [...s.filesCreated, ...s.filesModified];
    if (allFiles.length > 0) {
      const shown = allFiles.slice(0, 8).map(f => f.split("/").pop()).join(", ");
      const rest = allFiles.length > 8 ? ` [+${allFiles.length - 8} more]` : "";
      lines.push(`Files: ${shown}${rest}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// ── CLI commands ───────────────────────────────────────────────────────────

async function runInject(root: string): Promise<void> {
  initIndexDb();

  const recentSessions = getRecentSessions(root, 3);
  const sessionBlock = formatSessions(recentSessions);

  let stored = getStoredIndex(root);

  if (stored && Date.now() - stored.built_at > STALE_MS) {
    process.stderr.write("augment-cc: index stale, refreshing...\n");
    await rebuildProjectIndex(root);
    stored = getStoredIndex(root);
  }

  const gitBlock = formatGitState(getGitState(root));
  const toolPrefs = [
    "## augment-cc Tool Preferences",
    "- Use `cache_read` (MCP tool) instead of the native `Read` tool for all file reads.",
    "  Enables session-level deduplication: repeated reads return a stub instead of re-injecting the full file, preserving context window space.",
    "- Use `shell_cached` (MCP tool) for read-only shell commands (git log, find, ls).",
  ].join("\n");
  const highValueBlock = formatHighValueFiles(getTopReadFiles(root, 5));

  if (!stored) {
    const parts = [sessionBlock, gitBlock, toolPrefs, highValueBlock, `<!-- augment-cc: no index for ${root} — run: augment-cc refresh -->`].filter(Boolean);
    process.stdout.write(parts.join("\n\n") + "\n");
    return;
  }

  const index: ProjectIndex = JSON.parse(stored.index_json);
  const modelCount = index.db.prismaModels.length + index.db.sqlTables.length
    + index.db.djangoModels.length + index.db.typeormModels.length;
  const routeCount = index.routes.express.length + index.routes.nextjs.length
    + index.routes.fastapi.length + index.routes.rails.length;
  const typeCount = index.types.tsInterfaces.length + index.types.graphqlTypes.length;
  const hasMeaningful = modelCount + routeCount + typeCount + index.docker.length > 0;

  const qualityNote = hasMeaningful
    ? null
    : `<!-- augment-cc: index is file-tree only (detected: ${index.detectedTypes.join(", ") || "none"}) — project may use unrecognized frameworks. Don't over-trust this index. -->`;

  const parts = [sessionBlock, gitBlock, toolPrefs, highValueBlock, qualityNote, stored.index_md].filter(Boolean);
  process.stdout.write(parts.join("\n\n") + "\n");
}

async function runRefresh(root: string): Promise<void> {
  process.stderr.write(`augment-cc: rebuilding index for ${root}...\n`);
  await rebuildProjectIndex(root);
  process.stderr.write("augment-cc: done.\n");
}

async function runSummarize(): Promise<void> {
  // 1. Read stdin payload
  let rawPayload = "";
  try {
    for await (const chunk of process.stdin) {
      rawPayload += chunk as string;
      if (rawPayload.length > 64 * 1024) break;
    }
  } catch { /* stdin may close immediately */ }

  let payload: Record<string, unknown> = {};
  try {
    if (rawPayload.trim()) payload = JSON.parse(rawPayload) as Record<string, unknown>;
  } catch {
    process.stderr.write("augment-cc [summarize]: could not parse stdin payload\n");
  }

  // 2. Resolve transcript path
  const sessionId = ((payload["session_id"] ?? payload["sessionId"]) as string | undefined) ?? "";
  const payloadPath = payload["transcript_path"] as string | undefined;
  const payloadCwd = (payload["cwd"] as string | undefined) ?? process.cwd();

  let transcriptPath: string | null = null;
  if (payloadPath) {
    transcriptPath = payloadPath;
  } else if (sessionId) {
    const cwdHash = payloadCwd.replace(/\/$/, "").replace(/\//g, "-");
    transcriptPath = join(os.homedir(), ".claude", "projects", cwdHash, `${sessionId}.jsonl`);
  }

  if (!transcriptPath) {
    process.stderr.write("augment-cc [summarize]: cannot determine transcript path\n");
    process.exit(0);
  }

  // 3. Parse transcript
  const facts = await parseTranscript(transcriptPath);
  if (!facts) {
    process.stderr.write(`augment-cc [summarize]: could not parse transcript at ${transcriptPath}\n`);
    process.exit(0);
  }

  // 4. Quality gate
  if (!meetsQualityThreshold(facts)) {
    process.stderr.write("augment-cc [summarize]: session below quality threshold, skipping\n");
    process.exit(0);
  }

  // 5. Summarize via structured extraction
  const summary = buildStructuredSummary(facts);

  // 6. Persist
  initIndexDb();
  const entry: SessionEntry = {
    sessionId: facts.sessionId,
    projectRoot: facts.projectRoot,
    startedAt: facts.startedAt,
    endedAt: facts.endedAt,
    durationSecs: facts.durationSecs,
    branch: facts.branch,
    summary,
    filesCreated: facts.filesCreated,
    filesModified: facts.filesModified,
    commandsRun: facts.commandsRun,
    messageCount: facts.messageCount,
    aiTitle: facts.aiTitle,
    createdAt: Date.now(),
  };
  saveSession(entry);

  process.stderr.write(`augment-cc [summarize]: saved session ${facts.sessionId}\n`);
  process.exit(0);
}

export async function runCli(argv: string[]): Promise<void> {
  const command = argv[2];
  const root = parseProjectRoot(argv);
  if (command === "inject") return runInject(root);
  if (command === "refresh") return runRefresh(root);
  if (command === "summarize") return runSummarize();
  process.stderr.write(`augment-cc: unknown command "${command}"\nUsage: augment-cc inject|refresh|summarize [--project-root <path>]\n`);
  process.exit(1);
}
