import { resolve, join, dirname } from "path";
import os from "os";
import { realpathSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { initIndexDb, getStoredIndex, getRecentSessions, saveSession, getTopReadFiles } from "./indexer/db.js";
import { stats } from "./cache.js";
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
    if (s.decisions.length > 0) {
      const excerpts = s.decisions.map(d => `"${d}"`).join(" — ");
      lines.push(`Key decisions: ${excerpts}`);
    }
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
    "## augment-cc Tool Rules",
    "**ALWAYS use `cache_read` instead of native Read for file reads.** Native Read bypasses dedup — repeated reads accumulate full content in context instead of returning a short stub.",
    "**ALWAYS use `shell_cached` for read-only shell commands** (git log, git status, find, ls).",
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
  const hasMeaningful = modelCount + routeCount + typeCount + index.docker.length
    + (index.python?.length ?? 0) + (index.declarations?.length ?? 0) > 0;

  const qualityNote = hasMeaningful
    ? null
    : `<!-- augment-cc: index is file-tree only (detected: ${index.detectedTypes.join(", ") || "none"}) — project may use unrecognized frameworks. Don't over-trust this index. -->`;

  const MAX_CHARS = Number(process.env.AUGMENT_CC_INJECT_MAX_CHARS ?? 0);
  let indexBlock: string | null = stored.index_md;
  if (MAX_CHARS > 0) {
    const fixedChars = [sessionBlock, gitBlock, toolPrefs, highValueBlock, qualityNote]
      .filter(Boolean)
      .join("\n\n").length;
    const indexBudget = MAX_CHARS - fixedChars - 4;
    if (indexBudget <= 0) {
      indexBlock = `[augment-cc: index omitted — AUGMENT_CC_INJECT_MAX_CHARS budget exhausted by other sections]`;
    } else if (indexBlock.length > indexBudget) {
      indexBlock = indexBlock.slice(0, indexBudget) + `\n[augment-cc: index truncated — increase AUGMENT_CC_INJECT_MAX_CHARS to see more]`;
    }
  }

  const parts = [sessionBlock, gitBlock, toolPrefs, highValueBlock, qualityNote, indexBlock].filter(Boolean);
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
    decisions: facts.decisions,
    createdAt: Date.now(),
  };
  saveSession(entry);

  process.stderr.write(`augment-cc [summarize]: saved session ${facts.sessionId}\n`);
  process.exit(0);
}

// ── hook config checker ────────────────────────────────────────────────────

interface HookConfig {
  hasMcp: boolean;
  hasClaudeMd: boolean;
  hasStopHook: boolean;
  hasPreToolUseHook: boolean;
}

function checkHookConfig(root: string): HookConfig {
  // .mcp.json
  let hasMcp = false;
  try {
    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf-8")) as Record<string, unknown>;
    const servers = (mcp.mcpServers ?? {}) as Record<string, unknown>;
    hasMcp = "augment-cc" in servers;
  } catch { /* missing or unreadable */ }

  // CLAUDE.md
  let hasClaudeMd = false;
  try {
    const md = readFileSync(join(root, "CLAUDE.md"), "utf-8");
    hasClaudeMd = md.includes("augment-cc inject") || md.includes("dist/index.js inject");
  } catch { /* missing */ }

  // ~/.claude/settings.json Stop hook
  let hasStopHook = false;
  try {
    const settingsPath = join(os.homedir(), ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
    const stopHooks = (Array.isArray(hooks.Stop) ? hooks.Stop : []) as unknown[];
    hasStopHook = stopHooks.some((entry: unknown) => {
      const e = entry as Record<string, unknown>;
      const inner = e.hooks as Array<Record<string, unknown>> | undefined;
      return inner?.some(h => {
        const cmd = h.command as string | undefined;
        return typeof cmd === "string" && (cmd.includes("augment-cc summarize") || (cmd.includes("dist/index.js") && cmd.includes("summarize")));
      });
    });
  } catch { /* missing */ }

  // .claude/settings.local.json PreToolUse hook
  let hasPreToolUseHook = false;
  try {
    const localSettings = JSON.parse(readFileSync(join(root, ".claude", "settings.local.json"), "utf-8")) as Record<string, unknown>;
    const localHooks = (localSettings.hooks ?? {}) as Record<string, unknown>;
    const preHooks = (Array.isArray(localHooks.PreToolUse) ? localHooks.PreToolUse : []) as unknown[];
    hasPreToolUseHook = preHooks.some((entry: unknown) => {
      const e = entry as Record<string, unknown>;
      if ((e.matcher as string | undefined) !== "Read") return false;
      const inner = e.hooks as Array<Record<string, unknown>> | undefined;
      return inner?.some(h => {
        const cmd = h.command as string | undefined;
        return typeof cmd === "string" && (cmd.includes("augment-cc") || cmd.includes("dist/index.js"));
      });
    });
  } catch { /* missing */ }

  return { hasMcp, hasClaudeMd, hasStopHook, hasPreToolUseHook };
}

// ── init ───────────────────────────────────────────────────────────────────

async function runInit(root: string): Promise<void> {
  initIndexDb();
  const binPath = realpathSync(process.argv[1]);
  const results: string[] = [];

  // 1. .mcp.json
  const mcpPath = join(root, ".mcp.json");
  let mcpJson: Record<string, unknown> = {};
  let mcpExists = false;
  try {
    mcpJson = JSON.parse(readFileSync(mcpPath, "utf-8")) as Record<string, unknown>;
    mcpExists = true;
  } catch { /* will create fresh */ }

  const servers = ((mcpJson.mcpServers ?? {}) as Record<string, unknown>);
  if ("augment-cc" in servers) {
    results.push("  [skip] .mcp.json already configured");
  } else {
    servers["augment-cc"] = { type: "stdio", command: "node", args: [binPath], env: {} };
    mcpJson.mcpServers = servers;
    writeFileSync(mcpPath, JSON.stringify(mcpJson, null, 2));
    results.push(`  [done] .mcp.json ${mcpExists ? "updated" : "created"}`);
  }

  // 2. CLAUDE.md
  const claudeMdPath = join(root, "CLAUDE.md");
  const injectLine = `!node ${binPath} inject --project-root $PWD`;
  let claudeMdExists = false;
  let claudeMdContent = "";
  try {
    claudeMdContent = readFileSync(claudeMdPath, "utf-8");
    claudeMdExists = true;
  } catch { /* will create */ }

  if (claudeMdContent.includes("augment-cc inject") || claudeMdContent.includes("dist/index.js inject")) {
    results.push("  [skip] CLAUDE.md already configured");
  } else if (claudeMdExists) {
    writeFileSync(claudeMdPath, injectLine + "\n\n" + claudeMdContent);
    results.push("  [done] CLAUDE.md updated (inject line prepended)");
  } else {
    writeFileSync(claudeMdPath, injectLine + "\n");
    results.push("  [done] CLAUDE.md created");
  }

  // 3. ~/.claude/settings.json Stop hook
  const settingsPath = join(os.homedir(), ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch { /* missing or empty */ }

  const hooks = (settings.hooks ?? (settings.hooks = {})) as Record<string, unknown>;
  if (!Array.isArray(hooks.Stop)) hooks.Stop = [];
  const stopHooks = hooks.Stop as unknown[];

  const alreadyWired = stopHooks.some((entry: unknown) => {
    const e = entry as Record<string, unknown>;
    const inner = e.hooks as Array<Record<string, unknown>> | undefined;
    return inner?.some(h => {
      const cmd = h.command as string | undefined;
      return typeof cmd === "string" && (cmd.includes("augment-cc summarize") || (cmd.includes("dist/index.js") && cmd.includes("summarize")));
    });
  });

  if (alreadyWired) {
    results.push("  [skip] Stop hook already configured");
  } else {
    stopHooks.push({ matcher: "", hooks: [{ type: "command", command: `node ${binPath} summarize` }] });
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    results.push("  [done] Stop hook added to ~/.claude/settings.json");
  }

  // 4. .claude/settings.local.json PreToolUse hook (project-level, blocks native Read)
  const localSettingsDir = join(root, ".claude");
  const localSettingsPath = join(localSettingsDir, "settings.local.json");
  let localSettings: Record<string, unknown> = {};
  try {
    localSettings = JSON.parse(readFileSync(localSettingsPath, "utf-8")) as Record<string, unknown>;
  } catch { /* will create */ }

  const localHooks = (localSettings.hooks ?? (localSettings.hooks = {})) as Record<string, unknown>;
  if (!Array.isArray(localHooks.PreToolUse)) localHooks.PreToolUse = [];
  const preToolUseHooks = localHooks.PreToolUse as unknown[];

  const alreadyHasReadHook = preToolUseHooks.some((entry: unknown) => {
    const e = entry as Record<string, unknown>;
    return (e.matcher as string | undefined) === "Read" &&
      (e.hooks as Array<Record<string, unknown>> | undefined)?.some(h => {
        const cmd = h.command as string | undefined;
        return typeof cmd === "string" && (cmd.includes("augment-cc") || cmd.includes("dist/index.js"));
      });
  });

  if (alreadyHasReadHook) {
    results.push("  [skip] PreToolUse hook already configured");
  } else {
    preToolUseHooks.push({
      matcher: "Read",
      hooks: [{ type: "command", command: `node ${binPath} redirect-read` }],
    });
    mkdirSync(localSettingsDir, { recursive: true });
    writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2));
    results.push("  [done] PreToolUse hook added to .claude/settings.local.json (Read → cache_read redirect)");
  }

  // 5. First index build
  process.stderr.write("augment-cc: building initial project index...\n");
  await rebuildProjectIndex(root);

  // 6. Report
  results.push(`  [done] Project index built`);

  process.stdout.write(`\naugment-cc init complete for ${root}\n\n${results.join("\n")}\n\nRestart Claude Code to activate the MCP server.\n`);
}

// ── status ─────────────────────────────────────────────────────────────────

function runStatus(root: string): void {
  initIndexDb();

  const cacheStats = stats();
  const sessions = getRecentSessions(root, 1);
  const topFiles = getTopReadFiles(root, 3);
  const hookConfig = checkHookConfig(root);

  const lines: string[] = [`augment-cc status — ${root}`, ""];

  // Cache
  lines.push("Cache");
  lines.push(`  Total entries:  ${cacheStats.total}`);
  lines.push(`  Expired:        ${cacheStats.expired}`);
  lines.push("");

  // Sessions
  lines.push("Sessions (this project)");
  const sessionCount = getRecentSessions(root, 100).length;
  if (sessions.length === 0) {
    lines.push("  No sessions recorded yet");
  } else {
    lines.push(`  Recorded:       ${sessionCount}`);
    const s = sessions[0];
    const date = new Date(s.startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const dur = formatDuration(s.durationSecs);
    const title = s.aiTitle ? ` — ${s.aiTitle}` : "";
    lines.push(`  Most recent:    ${date}${title} (${dur} on \`${s.branch}\`)`);
  }
  lines.push("");

  // High-value files
  lines.push("High-value files");
  if (topFiles.length === 0) {
    lines.push("  None yet (accumulates across sessions)");
  } else {
    for (const f of topFiles) {
      const name = (f.file_path.split("/").pop() ?? f.file_path).padEnd(24);
      const sessStr = `${f.session_count} session${f.session_count === 1 ? "" : "s"}`;
      lines.push(`  ${name}  ${sessStr}, ${f.total_reads} total reads`);
    }
  }
  lines.push("");

  // Hooks
  lines.push("Hooks");
  const tick = (ok: boolean) => ok ? "✓" : "✗";
  lines.push(`  MCP server (.mcp.json):         ${tick(hookConfig.hasMcp)} ${hookConfig.hasMcp ? "augment-cc configured" : "not found — run augment-cc init"}`);
  lines.push(`  Inject hook (CLAUDE.md):        ${tick(hookConfig.hasClaudeMd)} ${hookConfig.hasClaudeMd ? "inject line present" : "not found — run augment-cc init"}`);
  lines.push(`  Stop hook (settings.json):      ${tick(hookConfig.hasStopHook)} ${hookConfig.hasStopHook ? "augment-cc summarize present" : "not found — run augment-cc init"}`);
  lines.push(`  PreToolUse hook (settings.local):${tick(hookConfig.hasPreToolUseHook)} ${hookConfig.hasPreToolUseHook ? "Read → cache_read redirect active" : "not found — run augment-cc init"}`);

  process.stdout.write(lines.join("\n") + "\n");
}

// ── CLI commands ───────────────────────────────────────────────────────────

export async function runCli(argv: string[]): Promise<void> {
  const command = argv[2];
  const root = parseProjectRoot(argv);
  if (command === "init") return runInit(root);
  if (command === "inject") return runInject(root);
  if (command === "refresh") return runRefresh(root);
  if (command === "summarize") return runSummarize();
  if (command === "status") return runStatus(root);
  if (command === "redirect-read") {
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: "augment-cc: use cache_read MCP tool instead of native Read — it provides session deduplication and mtime fast-path. Call cache_read with the same path argument. (If cache_read is unavailable because the MCP server is not connected, you may fall back to native Read.)",
    }) + "\n");
    return;
  }
  process.stderr.write([
    `augment-cc: unknown command "${command}"`,
    "",
    "Usage: augment-cc <command> [--project-root <path>]",
    "",
    "Commands:",
    "  init          Set up augment-cc in the current project",
    "  inject        Print context injection block (used by CLAUDE.md hook)",
    "  refresh       Force-rebuild the project index",
    "  summarize     Parse session transcript and save summary (used by Stop hook)",
    "  status        Show cache stats, session history, and hook configuration",
    "  redirect-read Output PreToolUse block decision (used by .claude/settings.local.json hook)",
    "",
  ].join("\n"));
  process.exit(1);
}
