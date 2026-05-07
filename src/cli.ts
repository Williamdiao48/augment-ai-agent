import { resolve, join, dirname } from "path";
import os from "os";
import { realpathSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { initIndexDb, getStoredIndex, getRecentSessions, saveSession, getTopReadFiles, saveAudit, getStoredAudit } from "./indexer/db.js";
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
    "**Use `cache_read` for information gathering** (exploring code, reading for context or reference). It deduplicates re-reads — unchanged files return a ~120-char stub instead of re-injecting full content.",
    "**Before Edit or Write: use native Read with `offset` + `limit`** scoped to just the lines you are changing. This satisfies the tool requirement at minimal token cost. Do not use native Read for information gathering.",
    "**If `cache_read` returns a stub and you have lost context to compaction:** call `cache_read` with `force: true` to recover the full file before editing.",
    "**If you lose project context (schema, routes, types, file tree) to compaction:** read the `project://index` MCP resource to recover the full project index without re-reading individual files.",
    "**Always use `shell_cached` for read-only shell commands** (git log, git status, find, ls).",
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

  const auditStored = getStoredAudit(root);
  const auditBlock = auditStored?.audit_md || null;

  const parts = [sessionBlock, gitBlock, toolPrefs, highValueBlock, auditBlock, qualityNote, indexBlock].filter(Boolean);
  process.stdout.write(parts.join("\n\n") + "\n");
}

async function runRefresh(root: string): Promise<void> {
  process.stderr.write(`augment-cc: rebuilding index for ${root}...\n`);
  await rebuildProjectIndex(root);
  process.stderr.write("augment-cc: done.\n");
}

// ── audit ──────────────────────────────────────────────────────────────────

import type { AuditResult } from "./indexer/audit.js";

function formatAuditReport(result: AuditResult, root: string): string {
  const lines: string[] = [`augment-cc audit — ${root}`, "", `  Files analyzed: ${result.analyzedCount}`];
  const OVERSIZED_LINES = Number(process.env.AUGMENT_CC_AUDIT_OVERSIZED_LINES ?? 300);
  const HIGH_EXPORTS    = Number(process.env.AUGMENT_CC_AUDIT_HIGH_EXPORTS ?? 15);

  if (result.oversizedFiles.length > 0) {
    lines.push("", `  Oversized files (>${OVERSIZED_LINES} lines):`);
    for (const f of result.oversizedFiles) {
      lines.push(`    ${f.path.padEnd(40)} ${f.lines} lines`);
    }
  }

  if (result.duplicateSymbols.length > 0) {
    lines.push("", "  Duplicate symbol names:");
    for (const d of result.duplicateSymbols) {
      lines.push(`    ${d.name.padEnd(20)} ${d.files.length} files — ${d.files.join(", ")}`);
    }
  }

  if (result.highExportFiles.length > 0) {
    lines.push("", `  High-export files (>${HIGH_EXPORTS} exports):`);
    for (const f of result.highExportFiles) {
      lines.push(`    ${f.path.padEnd(40)} ${f.exportCount} exports`);
    }
  }

  if (result.oversizedFiles.length === 0 && result.duplicateSymbols.length === 0 && result.highExportFiles.length === 0) {
    lines.push("", "  No issues found.");
  }

  return lines.join("\n");
}

async function runAudit(root: string): Promise<void> {
  initIndexDb();
  const { runCodeAudit } = await import("./indexer/audit.js");
  const auditResult = await runCodeAudit(root);
  if (!auditResult) {
    process.stdout.write("augment-cc audit: no project index found — run augment-cc init first\n");
    return;
  }
  saveAudit(root, JSON.stringify(auditResult.result), auditResult.md ?? "");
  process.stdout.write(formatAuditReport(auditResult.result, root) + "\n");
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
  hasPermissions: boolean;
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

  // .claude/settings.local.json PreToolUse hook + MCP permissions
  let hasPreToolUseHook = false;
  let hasPermissions = false;
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
    const localPerms = (localSettings.permissions ?? {}) as Record<string, unknown>;
    const allowed = (Array.isArray(localPerms.allow) ? localPerms.allow : []) as string[];
    hasPermissions = ["mcp__augment-cc__cache_read", "mcp__augment-cc__shell_cached"].every(t => allowed.includes(t));
  } catch { /* missing */ }

  return { hasMcp, hasClaudeMd, hasStopHook, hasPreToolUseHook, hasPermissions };
}

// ── init / upgrade shared config writer ───────────────────────────────────

async function writeHookConfig(root: string, binPath: string): Promise<string[]> {
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
    results.push("  [done] PreToolUse hook added to .claude/settings.local.json (Read → non-blocking cache_read reminder)");
  }

  // 5. .claude/settings.local.json MCP tool permissions (auto-approve cache_read + shell_cached)
  const MCP_TOOLS = ["mcp__augment-cc__cache_read", "mcp__augment-cc__shell_cached"];
  const perms = (localSettings.permissions ?? (localSettings.permissions = {})) as Record<string, unknown>;
  const allowed = (Array.isArray(perms.allow) ? perms.allow : (perms.allow = [])) as string[];
  const newTools = MCP_TOOLS.filter(t => !allowed.includes(t));
  if (newTools.length === 0) {
    results.push("  [skip] MCP tool permissions already configured");
  } else {
    allowed.push(...newTools);
    results.push("  [done] MCP tool permissions added to .claude/settings.local.json (auto-approve cache_read, shell_cached)");
  }

  mkdirSync(localSettingsDir, { recursive: true });
  writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2));

  return results;
}

// ── init ───────────────────────────────────────────────────────────────────

async function runInit(root: string): Promise<void> {
  initIndexDb();
  const binPath = realpathSync(process.argv[1]);

  const results = await writeHookConfig(root, binPath);

  process.stderr.write("augment-cc: building initial project index...\n");
  await rebuildProjectIndex(root);
  results.push(`  [done] Project index built`);

  process.stderr.write("augment-cc: running codebase audit...\n");
  const { runCodeAudit } = await import("./indexer/audit.js");
  const auditResult = await runCodeAudit(root);
  if (auditResult) {
    saveAudit(root, JSON.stringify(auditResult.result), auditResult.md ?? "");
    results.push(`  [done] Codebase audit complete`);
  }

  process.stdout.write(`\naugment-cc init complete for ${root}\n\n${results.join("\n")}\n\nRestart Claude Code to activate the MCP server.\n`);
  if (auditResult) {
    process.stdout.write("\n" + formatAuditReport(auditResult.result, root) + "\n");
  }
}

// ── upgrade ────────────────────────────────────────────────────────────────

async function runUpgrade(root: string): Promise<void> {
  initIndexDb();
  const binPath = realpathSync(process.argv[1]);

  const results = await writeHookConfig(root, binPath);

  const allSkipped = results.every(r => r.includes("[skip]"));
  if (allSkipped) {
    process.stdout.write(`\naugment-cc upgrade — ${root}\n\n${results.join("\n")}\n\nAll hooks up to date. No restart needed.\n`);
  } else {
    process.stdout.write(`\naugment-cc upgrade — ${root}\n\n${results.join("\n")}\n\nRestart Claude Code to activate any new hooks.\n`);
  }
}

// ── deactivate ─────────────────────────────────────────────────────────────

import { unlinkSync } from "fs";

async function runDeactivate(root: string): Promise<void> {
  const results: string[] = [];

  // 1. .mcp.json — remove augment-cc server entry
  const mcpPath = join(root, ".mcp.json");
  try {
    const mcpJson = JSON.parse(readFileSync(mcpPath, "utf-8")) as Record<string, unknown>;
    const servers = (mcpJson.mcpServers ?? {}) as Record<string, unknown>;
    if ("augment-cc" in servers) {
      delete servers["augment-cc"];
      mcpJson.mcpServers = servers;
      writeFileSync(mcpPath, JSON.stringify(mcpJson, null, 2));
      results.push("  [done] Removed augment-cc from .mcp.json");
    } else {
      results.push("  [skip] augment-cc not present in .mcp.json");
    }
  } catch {
    results.push("  [skip] .mcp.json not found");
  }

  // 2. CLAUDE.md — remove inject line
  const claudeMdPath = join(root, "CLAUDE.md");
  try {
    const content = readFileSync(claudeMdPath, "utf-8");
    if (content.includes("augment-cc inject") || content.includes("dist/index.js inject")) {
      const filtered = content
        .split("\n")
        .filter(l => !l.includes("augment-cc inject") && !l.includes("dist/index.js inject"))
        .join("\n")
        .replace(/^\n+/, ""); // trim leading blank lines left by removal
      if (filtered.trim() === "") {
        unlinkSync(claudeMdPath);
        results.push("  [done] Deleted CLAUDE.md (was only the inject line)");
      } else {
        writeFileSync(claudeMdPath, filtered);
        results.push("  [done] Removed inject line from CLAUDE.md");
      }
    } else {
      results.push("  [skip] augment-cc inject line not found in CLAUDE.md");
    }
  } catch {
    results.push("  [skip] CLAUDE.md not found");
  }

  // 3. .claude/settings.local.json — remove PreToolUse hook + MCP permissions
  const localSettingsPath = join(root, ".claude", "settings.local.json");
  try {
    const localSettings = JSON.parse(readFileSync(localSettingsPath, "utf-8")) as Record<string, unknown>;
    let changed = false;

    // Remove PreToolUse Read hook
    const localHooks = (localSettings.hooks ?? {}) as Record<string, unknown>;
    if (Array.isArray(localHooks.PreToolUse)) {
      const before = localHooks.PreToolUse.length;
      localHooks.PreToolUse = (localHooks.PreToolUse as unknown[]).filter((entry: unknown) => {
        const e = entry as Record<string, unknown>;
        if ((e.matcher as string | undefined) !== "Read") return true;
        const inner = e.hooks as Array<Record<string, unknown>> | undefined;
        return !inner?.some(h => {
          const cmd = h.command as string | undefined;
          return typeof cmd === "string" && (cmd.includes("augment-cc") || cmd.includes("dist/index.js"));
        });
      });
      if ((localHooks.PreToolUse as unknown[]).length < before) {
        changed = true;
        results.push("  [done] Removed PreToolUse Read hook from .claude/settings.local.json");
      } else {
        results.push("  [skip] PreToolUse Read hook not found in .claude/settings.local.json");
      }
    }

    // Remove MCP permissions
    const MCP_TOOLS = ["mcp__augment-cc__cache_read", "mcp__augment-cc__shell_cached"];
    const perms = (localSettings.permissions ?? {}) as Record<string, unknown>;
    if (Array.isArray(perms.allow)) {
      const before = perms.allow.length;
      perms.allow = (perms.allow as string[]).filter(t => !MCP_TOOLS.includes(t));
      if ((perms.allow as string[]).length < before) {
        changed = true;
        results.push("  [done] Removed MCP tool permissions from .claude/settings.local.json");
      } else {
        results.push("  [skip] MCP tool permissions not found in .claude/settings.local.json");
      }
    }

    if (changed) writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2));
  } catch {
    results.push("  [skip] .claude/settings.local.json not found");
  }

  process.stdout.write(
    `\naugment-cc deactivate — ${root}\n\n${results.join("\n")}\n\n` +
    `Note: the Stop hook in ~/.claude/settings.json is global and was not removed.\n` +
    `Run augment-cc init to re-activate.\n`
  );
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
  lines.push(`  MCP server (.mcp.json):         ${tick(hookConfig.hasMcp)} ${hookConfig.hasMcp ? "augment-cc configured" : "not found — run augment-cc upgrade"}`);
  lines.push(`  Inject hook (CLAUDE.md):        ${tick(hookConfig.hasClaudeMd)} ${hookConfig.hasClaudeMd ? "inject line present" : "not found — run augment-cc upgrade"}`);
  lines.push(`  Stop hook (settings.json):      ${tick(hookConfig.hasStopHook)} ${hookConfig.hasStopHook ? "augment-cc summarize present" : "not found — run augment-cc upgrade"}`);
  lines.push(`  PreToolUse hook (settings.local):${tick(hookConfig.hasPreToolUseHook)} ${hookConfig.hasPreToolUseHook ? "Read reminder active (non-blocking, allows native Read for Edit/Write)" : "not found — run augment-cc upgrade"}`);
  lines.push(`  MCP permissions (settings.local): ${tick(hookConfig.hasPermissions)} ${hookConfig.hasPermissions ? "cache_read + shell_cached auto-approved" : "not found — run augment-cc upgrade"}`);

  process.stdout.write(lines.join("\n") + "\n");
}

// ── CLI commands ───────────────────────────────────────────────────────────

export async function runCli(argv: string[]): Promise<void> {
  const command = argv[2];
  const root = parseProjectRoot(argv);
  if (command === "init") return runInit(root);
  if (command === "upgrade") return runUpgrade(root);
  if (command === "deactivate") return runDeactivate(root);
  if (command === "audit") return runAudit(root);
  if (command === "inject") return runInject(root);
  if (command === "refresh") return runRefresh(root);
  if (command === "summarize") return runSummarize();
  if (command === "status") return runStatus(root);
  if (command === "redirect-read") {
    process.stdout.write(
      "augment-cc: For information gathering prefer cache_read (dedup returns a stub on re-reads, saving tokens). " +
      "If you are about to call Edit or Write, proceed with this native Read — use offset + limit to read only the section you are changing. " +
      "If cache_read returned a stub and context was lost to compaction, call cache_read with force: true to recover the full content before editing.\n"
    );
    return;
  }
  process.stderr.write([
    `augment-cc: unknown command "${command}"`,
    "",
    "Usage: augment-cc <command> [--project-root <path>]",
    "",
    "Commands:",
    "  init          Set up augment-cc in the current project (writes hooks + builds index + audit)",
    "  upgrade       Re-apply latest hook config without rebuilding the index (run after git pull)",
    "  deactivate    Remove augment-cc hooks from the current project (re-activate with init)",
    "  audit         Analyze codebase for oversized files, duplicate function names, and dumping-ground files",
    "  inject        Print context injection block (used by CLAUDE.md hook)",
    "  refresh       Force-rebuild the project index",
    "  summarize     Parse session transcript and save summary (used by Stop hook)",
    "  status        Show cache stats, session history, and hook configuration",
    "  redirect-read Output PreToolUse block decision (used by .claude/settings.local.json hook)",
    "",
  ].join("\n"));
  process.exit(1);
}
