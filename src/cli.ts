import { resolve, join, dirname } from "path";
import os from "os";
import { realpathSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { initIndexDb, getStoredIndex, getRecentSessions, saveSession, getTopReadFiles, saveAudit, getStoredAudit, recordCompaction, recordRead, recordCommandRun, getAllSavedCommands, getTopCommandRuns } from "./indexer/db.js";
import { buildCompactInject } from "./indexer/compact-inject.js";
import { stats, hashContent } from "./cache.js";
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

// ── script library formatter ───────────────────────────────────────────────

function formatAge(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function formatScriptLibrary(
  saved: Array<{ name: string; description: string; run_count: number; last_failed_at?: number | null }>,
  frequent: Array<{ command: string; run_count: number }>,
): string | null {
  if (saved.length === 0 && frequent.length === 0) return null;

  const lines: string[] = [];

  if (saved.length > 0) {
    lines.push("## Script Library", "");
    for (const s of saved) {
      const failNote = s.last_failed_at ? ` [last failed: ${formatAge(s.last_failed_at)}]` : "";
      lines.push(`- \`${s.name}\` — ${s.description}${failNote}`);
    }
    lines.push("");
    lines.push("Run any of these with `run_saved_command(name)`. Update a script with `bash(command, { save_as: 'name' })`.");
  }

  if (frequent.length > 0) {
    lines.push("", "## Frequently Run Commands (not yet saved)", "");
    for (const f of frequent) {
      const preview = f.command.length > 60 ? f.command.slice(0, 60) + "…" : f.command;
      lines.push(`- \`${preview}\` (${f.run_count}×)`);
    }
    lines.push("");
    lines.push("Use `bash(command, { save_as: 'name' })` to save any of these for quick reuse.");
  }

  return lines.join("\n").trimEnd();
}

// ── file tree formatter (used when full index is skipped) ──────────────────

function formatFileTreeBlock(index: ProjectIndex): string {
  const { fileTree } = index;
  const lines: string[] = [
    `# Project Index`,
    `Root: \`${index.projectRoot}\` | Files: ${fileTree.totalFiles}`,
  ];
  if (fileTree.topDirs.length) lines.push(`Dirs: ${fileTree.topDirs.join("  ")}`);
  const extSummary = Object.entries(fileTree.byExtension)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, n]) => `${ext}(${n})`)
    .join("  ");
  if (extSummary) lines.push(`Exts: ${extSummary}`);
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
    if (s.closingNotes.length > 0) {
      lines.push(`Concluded: "${s.closingNotes[s.closingNotes.length - 1]}"`);
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
  const highValueBlock = formatHighValueFiles(getTopReadFiles(root, 5));
  const savedCmds = getAllSavedCommands(root);
  const savedScripts = savedCmds.map(c => c.script);
  const frequentCmds = getTopCommandRuns(root, 5, savedScripts);
  const scriptLibraryBlock = formatScriptLibrary(savedCmds, frequentCmds);

  if (!stored) {
    const parts = [sessionBlock, gitBlock, highValueBlock, scriptLibraryBlock, `<!-- augment-cc: no index for ${root} — run: augment-cc refresh -->`].filter(Boolean);
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
    + (index.python?.length ?? 0) > 0;

  if (!hasMeaningful) {
    const treeBlock = formatFileTreeBlock(index);
    const noSchemaNote = `<!-- augment-cc: no recognized schema/routes detected — explore files directly or run \`augment-cc refresh\` after adding a supported framework -->`;
    const parts = [sessionBlock, gitBlock, highValueBlock, scriptLibraryBlock, treeBlock, noSchemaNote].filter(Boolean);
    process.stdout.write(parts.join("\n\n") + "\n");
    return;
  }

  const INDEX_MAX_CHARS = Number(process.env.AUGMENT_CC_INJECT_MAX_CHARS ?? 6_000);
  let indexBlock: string | null = stored.index_md;
  if (indexBlock && indexBlock.length > INDEX_MAX_CHARS) {
    indexBlock = indexBlock.slice(0, INDEX_MAX_CHARS) +
      `\n[augment-cc: index truncated at ${INDEX_MAX_CHARS} chars — read the \`project://index\` MCP resource for the full index]`;
  }

  const auditStored = getStoredAudit(root);
  let auditBlock: string | null = null;
  if (auditStored) {
    const AUDIT_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
    if (Date.now() - auditStored.audited_at <= AUDIT_MAX_AGE_MS) {
      auditBlock = auditStored.audit_md;
    } else {
      const daysSince = Math.round((Date.now() - auditStored.audited_at) / (24 * 3600 * 1000));
      auditBlock = `<!-- augment-cc: last audit was ${daysSince} days ago — run \`augment-cc audit\` to refresh -->`;
    }
  }

  const parts = [sessionBlock, gitBlock, highValueBlock, scriptLibraryBlock, auditBlock, indexBlock].filter(Boolean);
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

  // 6. Generate session title: try claude -p, fall back to first user message words
  let aiTitle: string | null = facts.aiTitle;
  if (!aiTitle) {
    try {
      const prompt = `Give a 4-6 word title for this work session. Reply with ONLY the title, no quotes or punctuation at end. Session: ${summary.slice(0, 300)}`;
      const raw = execSync(`claude -p ${JSON.stringify(prompt)}`, {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim().replace(/^["']|["']$/g, "");
      if (raw.length > 0 && raw.length < 80) aiTitle = raw;
    } catch { /* claude CLI unavailable or timed out */ }
  }
  if (!aiTitle && facts.firstUserMessage) {
    const words = facts.firstUserMessage.trim().split(/\s+/);
    aiTitle = words.slice(0, 8).join(" ") + (words.length > 8 ? "…" : "");
  }

  // 7. Persist
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
    aiTitle,
    closingNotes: facts.closingNotes,
    createdAt: Date.now(),
  };
  saveSession(entry);

  process.stderr.write(`augment-cc [summarize]: saved session ${facts.sessionId}\n`);
  process.exit(0);
}

// ── hook config checker ────────────────────────────────────────────────────

interface HookConfig {
  hasMcp: boolean;
  hasSessionStartHook: boolean;
  hasStaticRules: boolean;
  hasStopHook: boolean;
  hasPostCompactHook: boolean;
  hasPermissions: boolean;
  hasReadTrackingHook: boolean;
  hasBashTrackingHook: boolean;
}

function checkHookConfig(root: string): HookConfig {
  // .mcp.json
  let hasMcp = false;
  try {
    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf-8")) as Record<string, unknown>;
    const servers = (mcp.mcpServers ?? {}) as Record<string, unknown>;
    hasMcp = "augment-cc" in servers;
  } catch { /* missing or unreadable */ }

  // CLAUDE.md static rules
  let hasStaticRules = false;
  try {
    const md = readFileSync(join(root, "CLAUDE.md"), "utf-8");
    hasStaticRules = md.includes("<!-- augment-cc:rules:start -->");
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

  // .claude/settings.local.json SessionStart + PostCompact hooks + MCP permissions
  let hasSessionStartHook = false;
  let hasPostCompactHook = false;
  let hasPermissions = false;
  let hasReadTrackingHook = false;
  let hasBashTrackingHook = false;
  try {
    const localSettings = JSON.parse(readFileSync(join(root, ".claude", "settings.local.json"), "utf-8")) as Record<string, unknown>;
    const localHooks = (localSettings.hooks ?? {}) as Record<string, unknown>;

    const sessionStartHooks = (Array.isArray(localHooks.SessionStart) ? localHooks.SessionStart : []) as unknown[];
    hasSessionStartHook = sessionStartHooks.some((entry: unknown) => {
      const e = entry as Record<string, unknown>;
      const inner = e.hooks as Array<Record<string, unknown>> | undefined;
      return inner?.some(h => {
        const cmd = h.command as string | undefined;
        return typeof cmd === "string" && (cmd.includes("augment-cc inject") || (cmd.includes("dist/index.js") && cmd.includes("inject")));
      });
    });

    const postHooks = (Array.isArray(localHooks.PostCompact) ? localHooks.PostCompact : []) as unknown[];
    hasPostCompactHook = postHooks.some((entry: unknown) => {
      const e = entry as Record<string, unknown>;
      const inner = e.hooks as Array<Record<string, unknown>> | undefined;
      return inner?.some(h => {
        const cmd = h.command as string | undefined;
        return typeof cmd === "string" && (cmd.includes("augment-cc") || cmd.includes("dist/index.js"));
      });
    });

    const localPerms = (localSettings.permissions ?? {}) as Record<string, unknown>;
    const allowed = (Array.isArray(localPerms.allow) ? localPerms.allow : []) as string[];
    hasPermissions = ["mcp__augment-cc__search_file", "mcp__augment-cc__bash"].every(t => allowed.includes(t));

    const preToolUse = (Array.isArray(localHooks.PreToolUse) ? localHooks.PreToolUse : []) as unknown[];
    hasReadTrackingHook = preToolUse.some((entry: unknown) => {
      const e = entry as Record<string, unknown>;
      const inner = e.hooks as Array<Record<string, unknown>> | undefined;
      return inner?.some(h => {
        const cmd = h.command as string | undefined;
        return typeof cmd === "string" && cmd.includes("track-read");
      });
    });

    const postToolUse = (Array.isArray(localHooks.PostToolUse) ? localHooks.PostToolUse : []) as unknown[];
    hasBashTrackingHook = postToolUse.some((entry: unknown) => {
      const e = entry as Record<string, unknown>;
      const inner = e.hooks as Array<Record<string, unknown>> | undefined;
      return inner?.some(h => {
        const cmd = h.command as string | undefined;
        return typeof cmd === "string" && cmd.includes("track-bash");
      });
    });
  } catch { /* missing */ }

  return { hasMcp, hasSessionStartHook, hasStaticRules, hasStopHook, hasPostCompactHook, hasPermissions, hasReadTrackingHook, hasBashTrackingHook };
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

  // 2. CLAUDE.md — remove legacy ! inject line (inject is now a SessionStart hook)
  const claudeMdPath = join(root, "CLAUDE.md");
  let claudeMdContent = "";
  try { claudeMdContent = readFileSync(claudeMdPath, "utf-8"); } catch { /* will be created by static rules step */ }

  if (claudeMdContent.includes("augment-cc inject") || claudeMdContent.includes("dist/index.js inject")) {
    const stripped = claudeMdContent
      .split("\n")
      .filter(l => !l.includes("augment-cc inject") && !l.includes("dist/index.js inject"))
      .join("\n")
      .replace(/^\n+/, "");
    writeFileSync(claudeMdPath, stripped);
    claudeMdContent = stripped;
    results.push("  [done] CLAUDE.md: removed legacy ! inject line (now a SessionStart hook)");
  } else {
    results.push("  [skip] CLAUDE.md: no legacy inject line");
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

  // 2b. CLAUDE.md static rules section (idempotent update by delimiter)
  const RULES_START = "<!-- augment-cc:rules:start -->";
  const RULES_END = "<!-- augment-cc:rules:end -->";
  const STATIC_RULES_CONTENT = [
    "## augment-cc Tool Rules",
    "- Use **`search_file(path, keyword)`** to locate a function or symbol — returns the relevant section with line numbers. Use those line numbers for a targeted native Read before Edit.",
    "- Use **`bash(command)`** for shell commands — applies output filtering and tracks usage. Pass `{ save_as: 'name' }` to save for reuse. Use **`run_saved_command(name)`** for saved scripts and **`list_commands()`** to browse them.",
  ].join("\n");
  const STATIC_RULES_BLOCK = `${RULES_START}\n${STATIC_RULES_CONTENT}\n${RULES_END}`;

  let claudeMdForRules = "";
  try { claudeMdForRules = readFileSync(claudeMdPath, "utf-8"); } catch { /* may not exist yet */ }

  if (claudeMdForRules.includes(RULES_START)) {
    const startIdx = claudeMdForRules.indexOf(RULES_START);
    const endIdx = claudeMdForRules.indexOf(RULES_END);
    if (endIdx !== -1) {
      const before = claudeMdForRules.slice(0, startIdx);
      const after = claudeMdForRules.slice(endIdx + RULES_END.length);
      writeFileSync(claudeMdPath, before + STATIC_RULES_BLOCK + after);
      results.push("  [done] CLAUDE.md static tool rules updated");
    } else {
      results.push("  [skip] CLAUDE.md static rules block has no end marker — manual fix needed");
    }
  } else {
    const existing = claudeMdForRules.trimEnd();
    writeFileSync(claudeMdPath, existing + (existing ? "\n\n" : "") + STATIC_RULES_BLOCK + "\n");
    results.push("  [done] CLAUDE.md static tool rules added");
  }

  // 4. .claude/settings.local.json — remove legacy PreToolUse hook (superseded by static CLAUDE.md)
  const localSettingsDir = join(root, ".claude");
  const localSettingsPath = join(localSettingsDir, "settings.local.json");
  let localSettings: Record<string, unknown> = {};
  try {
    localSettings = JSON.parse(readFileSync(localSettingsPath, "utf-8")) as Record<string, unknown>;
  } catch { /* will create */ }

  const localHooks = (localSettings.hooks ?? (localSettings.hooks = {})) as Record<string, unknown>;

  if (Array.isArray(localHooks.PreToolUse)) {
    const before = (localHooks.PreToolUse as unknown[]).length;
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
      results.push("  [done] Removed legacy PreToolUse Read hook from .claude/settings.local.json");
    } else {
      results.push("  [skip] No legacy PreToolUse hook found");
    }
  } else {
    results.push("  [skip] No PreToolUse hooks configured");
  }

  // 4b. Silent Read tracking hook — records file paths to session_reads for compact-inject
  if (!Array.isArray(localHooks.PreToolUse)) localHooks.PreToolUse = [];
  const preToolUseHooks = localHooks.PreToolUse as unknown[];

  const alreadyHasTracking = preToolUseHooks.some((entry: unknown) => {
    const e = entry as Record<string, unknown>;
    const inner = e.hooks as Array<Record<string, unknown>> | undefined;
    return inner?.some(h => {
      const cmd = h.command as string | undefined;
      return typeof cmd === "string" && cmd.includes("track-read");
    });
  });

  if (alreadyHasTracking) {
    results.push("  [skip] Read tracking hook already configured");
  } else {
    preToolUseHooks.push({
      matcher: "Read",
      hooks: [{ type: "command", command: `node ${binPath} track-read --project-root ${root}` }],
    });
    results.push("  [done] Silent Read tracking hook added to .claude/settings.local.json");
  }

  // 4c. SessionStart hooks (startup + resume) — inject on new session and resume
  if (!Array.isArray(localHooks.SessionStart)) localHooks.SessionStart = [];
  const sessionStartHooks = localHooks.SessionStart as unknown[];

  const alreadyHasSessionStart = sessionStartHooks.some((entry: unknown) => {
    const e = entry as Record<string, unknown>;
    const inner = e.hooks as Array<Record<string, unknown>> | undefined;
    return inner?.some(h => {
      const cmd = h.command as string | undefined;
      return typeof cmd === "string" && (cmd.includes("augment-cc inject") || (cmd.includes("dist/index.js") && cmd.includes("inject")));
    });
  });

  if (alreadyHasSessionStart) {
    results.push("  [skip] SessionStart inject hooks already configured");
  } else {
    sessionStartHooks.push({
      matcher: "startup",
      hooks: [{ type: "command", command: `node ${binPath} inject --project-root ${root}` }],
    });
    sessionStartHooks.push({
      matcher: "resume",
      hooks: [{ type: "command", command: `node ${binPath} inject --project-root ${root}` }],
    });
    results.push("  [done] SessionStart hooks added (startup + resume) to .claude/settings.local.json");
  }

  // 4d. PostToolUse Bash tracking hook — passive command tracking via native Bash
  if (!Array.isArray(localHooks.PostToolUse)) localHooks.PostToolUse = [];
  const postToolUseHooks = localHooks.PostToolUse as unknown[];

  const alreadyHasBashTracking = postToolUseHooks.some((entry: unknown) => {
    const e = entry as Record<string, unknown>;
    const inner = e.hooks as Array<Record<string, unknown>> | undefined;
    return inner?.some(h => {
      const cmd = h.command as string | undefined;
      return typeof cmd === "string" && cmd.includes("track-bash");
    });
  });

  if (alreadyHasBashTracking) {
    results.push("  [skip] Bash tracking hook already configured");
  } else {
    postToolUseHooks.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: `node ${binPath} track-bash --project-root ${root}` }],
    });
    results.push("  [done] PostToolUse Bash tracking hook added to .claude/settings.local.json");
  }

  // 5. .claude/settings.local.json MCP tool permissions (auto-approve search_file + bash)
  const MCP_TOOLS = [
    "mcp__augment-cc__search_file",
    "mcp__augment-cc__bash",
    "mcp__augment-cc__run_saved_command",
    "mcp__augment-cc__list_commands",
    "mcp__augment-cc__delete_command",
  ];
  const perms = (localSettings.permissions ?? (localSettings.permissions = {})) as Record<string, unknown>;
  const allowed = (Array.isArray(perms.allow) ? perms.allow : (perms.allow = [])) as string[];
  // Migrate legacy permission entries
  for (const legacy of ["mcp__augment-cc__cache_read", "mcp__augment-cc__shell_cached"]) {
    const idx = (allowed as string[]).indexOf(legacy);
    if (idx !== -1) (allowed as string[]).splice(idx, 1);
  }
  const legacyCacheReadIdx = (allowed as string[]).indexOf("mcp__augment-cc__search_file");
  if (legacyCacheReadIdx === -1) { /* will be added below */ }
  const newTools = MCP_TOOLS.filter(t => !allowed.includes(t));
  if (newTools.length === 0) {
    results.push("  [skip] MCP tool permissions already configured");
  } else {
    allowed.push(...newTools);
    results.push("  [done] MCP tool permissions added to .claude/settings.local.json (auto-approve search_file, bash + script tools)");
  }

  // 6. .claude/settings.local.json PostCompact hook (re-inject context after compaction)
  if (!Array.isArray(localHooks.PostCompact)) localHooks.PostCompact = [];
  const postCompactHooks = localHooks.PostCompact as unknown[];
  const compactInjectCmd = `node ${binPath} compact-inject --project-root ${root}`;

  const alreadyHasCompactInject = postCompactHooks.some((entry: unknown) => {
    const e = entry as Record<string, unknown>;
    const inner = e.hooks as Array<Record<string, unknown>> | undefined;
    return inner?.some(h => {
      const cmd = h.command as string | undefined;
      return typeof cmd === "string" && cmd.includes("compact-inject");
    });
  });

  if (alreadyHasCompactInject) {
    results.push("  [skip] PostCompact hook already configured (compact-inject)");
  } else {
    // Migrate legacy post-compact → compact-inject in place, or add fresh
    let migrated = false;
    for (const entry of postCompactHooks) {
      const e = entry as Record<string, unknown>;
      const inner = e.hooks as Array<Record<string, unknown>> | undefined;
      if (inner) {
        for (const h of inner) {
          const cmd = h.command as string | undefined;
          if (typeof cmd === "string" && cmd.includes("post-compact")) {
            h.command = compactInjectCmd;
            migrated = true;
          }
        }
      }
    }
    if (migrated) {
      results.push("  [done] PostCompact hook migrated from post-compact to compact-inject");
    } else {
      postCompactHooks.push({
        matcher: "",
        hooks: [{ type: "command", command: compactInjectCmd }],
      });
      results.push("  [done] PostCompact hook added to .claude/settings.local.json (targeted re-inject after compaction)");
    }
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

// ── post-compact ───────────────────────────────────────────────────────────

async function runPostCompact(): Promise<void> {
  let rawPayload = "";
  try {
    for await (const chunk of process.stdin) {
      rawPayload += chunk as string;
      if (rawPayload.length > 8 * 1024) break;
    }
  } catch { /* stdin may close immediately */ }

  let payload: Record<string, unknown> = {};
  try {
    if (rawPayload.trim()) payload = JSON.parse(rawPayload) as Record<string, unknown>;
  } catch { /* use cwd fallback */ }

  const root = resolve((payload["cwd"] as string | undefined) ?? process.cwd());

  process.stdout.write("[augment-cc: compaction detected — re-injecting project context]\n\n");
  initIndexDb();
  recordCompaction(root);
  await runInject(root);
}

// ── track-read ─────────────────────────────────────────────────────────────

async function runTrackRead(root: string): Promise<void> {
  // Silent PreToolUse hook — records native Read file paths to session_reads for compact-inject.
  // No stdout output. Exit 0 always so the Read proceeds normally.
  try {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk as string;
      if (raw.length > 4 * 1024) break;
    }
    const payload = JSON.parse(raw) as { session_id?: string; tool_input?: { file_path?: string } };
    const filePath = payload.tool_input?.file_path;
    const sessionId = payload.session_id ?? "tracked";
    if (!filePath || !filePath.startsWith(root)) return;
    initIndexDb();
    recordRead(sessionId, filePath, "tracked");
  } catch { /* never block the Read */ }
}

// ── track-bash ─────────────────────────────────────────────────────────────

async function runTrackBash(root: string): Promise<void> {
  // Silent PostToolUse hook — records native Bash commands to command_runs for script library.
  // No stdout output. Exit 0 always so the Bash proceeds normally.
  try {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk as string;
      if (raw.length > 4 * 1024) break;
    }
    const payload = JSON.parse(raw) as { tool_input?: { command?: string } };
    const command = payload.tool_input?.command;
    if (!command || command.trim().length === 0) return;
    initIndexDb();
    recordCommandRun(root, hashContent(command).slice(0, 16), command);
  } catch { /* never block */ }
}

// ── compact-inject ─────────────────────────────────────────────────────────

async function runCompactInject(root: string): Promise<void> {
  initIndexDb();
  recordCompaction(root);
  const output = await buildCompactInject(root);
  process.stdout.write(output + "\n");
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

  // 2. CLAUDE.md — remove inject line and static rules block
  const claudeMdPath = join(root, "CLAUDE.md");
  try {
    const content = readFileSync(claudeMdPath, "utf-8");
    let filtered = content;
    let claudeChanged = false;

    if (filtered.includes("augment-cc inject") || filtered.includes("dist/index.js inject")) {
      filtered = filtered
        .split("\n")
        .filter(l => !l.includes("augment-cc inject") && !l.includes("dist/index.js inject"))
        .join("\n")
        .replace(/^\n+/, "");
      claudeChanged = true;
      results.push("  [done] Removed inject line from CLAUDE.md");
    } else {
      results.push("  [skip] augment-cc inject line not found in CLAUDE.md");
    }

    if (filtered.includes("<!-- augment-cc:rules:start -->")) {
      const startIdx = filtered.indexOf("<!-- augment-cc:rules:start -->");
      const endIdx = filtered.indexOf("<!-- augment-cc:rules:end -->");
      if (endIdx !== -1) {
        filtered = (filtered.slice(0, startIdx) + filtered.slice(endIdx + "<!-- augment-cc:rules:end -->".length))
          .replace(/\n{3,}/g, "\n\n")
          .trimStart();
        claudeChanged = true;
        results.push("  [done] Removed static tool rules from CLAUDE.md");
      }
    }

    if (claudeChanged) {
      if (filtered.trim() === "") {
        unlinkSync(claudeMdPath);
        results.push("  [done] Deleted CLAUDE.md (now empty)");
      } else {
        writeFileSync(claudeMdPath, filtered);
      }
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

    // Remove SessionStart hooks
    if (Array.isArray(localHooks.SessionStart)) {
      const before = (localHooks.SessionStart as unknown[]).length;
      localHooks.SessionStart = (localHooks.SessionStart as unknown[]).filter((entry: unknown) => {
        const e = entry as Record<string, unknown>;
        const inner = e.hooks as Array<Record<string, unknown>> | undefined;
        return !inner?.some(h => {
          const cmd = h.command as string | undefined;
          return typeof cmd === "string" && (cmd.includes("augment-cc inject") || (cmd.includes("dist/index.js") && cmd.includes("inject")));
        });
      });
      if ((localHooks.SessionStart as unknown[]).length < before) {
        changed = true;
        results.push("  [done] Removed SessionStart inject hooks from .claude/settings.local.json");
      } else {
        results.push("  [skip] SessionStart inject hooks not found in .claude/settings.local.json");
      }
    }

    // Remove PostCompact hook
    if (Array.isArray(localHooks.PostCompact)) {
      const before = (localHooks.PostCompact as unknown[]).length;
      localHooks.PostCompact = (localHooks.PostCompact as unknown[]).filter((entry: unknown) => {
        const e = entry as Record<string, unknown>;
        const inner = e.hooks as Array<Record<string, unknown>> | undefined;
        return !inner?.some(h => {
          const cmd = h.command as string | undefined;
          return typeof cmd === "string" && (cmd.includes("augment-cc") || cmd.includes("dist/index.js"));
        });
      });
      if ((localHooks.PostCompact as unknown[]).length < before) {
        changed = true;
        results.push("  [done] Removed PostCompact hook from .claude/settings.local.json");
      } else {
        results.push("  [skip] PostCompact hook not found in .claude/settings.local.json");
      }
    }

    // Remove PostToolUse Bash tracking hook
    if (Array.isArray(localHooks.PostToolUse)) {
      const before = (localHooks.PostToolUse as unknown[]).length;
      localHooks.PostToolUse = (localHooks.PostToolUse as unknown[]).filter((entry: unknown) => {
        const e = entry as Record<string, unknown>;
        const inner = e.hooks as Array<Record<string, unknown>> | undefined;
        return !inner?.some(h => {
          const cmd = h.command as string | undefined;
          return typeof cmd === "string" && cmd.includes("track-bash");
        });
      });
      if ((localHooks.PostToolUse as unknown[]).length < before) {
        changed = true;
        results.push("  [done] Removed PostToolUse Bash tracking hook from .claude/settings.local.json");
      } else {
        results.push("  [skip] PostToolUse Bash tracking hook not found in .claude/settings.local.json");
      }
    }

    // Remove MCP permissions
    const MCP_TOOLS = [
      "mcp__augment-cc__search_file",
      "mcp__augment-cc__bash",
      "mcp__augment-cc__run_saved_command",
      "mcp__augment-cc__list_commands",
      "mcp__augment-cc__delete_command",
      "mcp__augment-cc__shell_cached",
      "mcp__augment-cc__cache_read",
    ];
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
  lines.push(`  MCP server (.mcp.json):            ${tick(hookConfig.hasMcp)} ${hookConfig.hasMcp ? "augment-cc configured" : "not found — run augment-cc upgrade"}`);
  lines.push(`  SessionStart hook (settings.local): ${tick(hookConfig.hasSessionStartHook)} ${hookConfig.hasSessionStartHook ? "inject on startup + resume" : "not found — run augment-cc upgrade"}`);
  lines.push(`  Read tracking hook (settings.local):${tick(hookConfig.hasReadTrackingHook)} ${hookConfig.hasReadTrackingHook ? "silent native Read tracking active" : "not found — run augment-cc upgrade"}`);
  lines.push(`  Static tool rules (CLAUDE.md):     ${tick(hookConfig.hasStaticRules)} ${hookConfig.hasStaticRules ? "tool rules section present" : "not found — run augment-cc upgrade"}`);
  lines.push(`  Stop hook (settings.json):         ${tick(hookConfig.hasStopHook)} ${hookConfig.hasStopHook ? "augment-cc summarize present" : "not found — run augment-cc upgrade"}`);
  lines.push(`  PostCompact hook (settings.local):  ${tick(hookConfig.hasPostCompactHook)} ${hookConfig.hasPostCompactHook ? "compact-inject active (targeted re-inject after compaction)" : "not found — run augment-cc upgrade"}`);
  lines.push(`  Bash tracking hook (settings.local):${tick(hookConfig.hasBashTrackingHook)} ${hookConfig.hasBashTrackingHook ? "passive Bash command tracking active" : "not found — run augment-cc upgrade"}`);
  lines.push(`  MCP permissions (settings.local):   ${tick(hookConfig.hasPermissions)} ${hookConfig.hasPermissions ? "search_file + bash auto-approved" : "not found — run augment-cc upgrade"}`);

  process.stdout.write(lines.join("\n") + "\n");
}

// ── CLI commands ───────────────────────────────────────────────────────────

export async function runCli(argv: string[]): Promise<void> {
  const command = argv[2];
  const root = parseProjectRoot(argv);
  if (command === "init") return runInit(root);
  if (command === "upgrade") return runUpgrade(root);
  if (command === "deactivate") return runDeactivate(root);
  if (command === "post-compact") return runPostCompact();
  if (command === "compact-inject") return runCompactInject(root);
  if (command === "track-read") return runTrackRead(root);
  if (command === "track-bash") return runTrackBash(root);
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
    "  inject         Print full context injection block (used by SessionStart hook)",
    "  compact-inject Print targeted post-compact context block (used by PostCompact hook)",
    "  refresh        Force-rebuild the project index",
    "  summarize      Parse session transcript and save summary (used by Stop hook)",
    "  status         Show cache stats, session history, and hook configuration",
    "  post-compact   Legacy: full re-inject after compaction (superseded by compact-inject)",
    "",
  ].join("\n"));
  process.exit(1);
}
