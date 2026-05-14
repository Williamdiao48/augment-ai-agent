import { getDb } from "../cache.js";
import type { SessionEntry } from "./types.js";

const MAX_SESSIONS = Number(process.env.AUGMENT_CC_MAX_SESSIONS ?? 10);

export function initIndexDb(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_index (
      project_root  TEXT PRIMARY KEY,
      index_json    TEXT NOT NULL,
      index_md      TEXT NOT NULL,
      built_at      INTEGER NOT NULL,
      file_count    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS index_files (
      project_root  TEXT NOT NULL,
      file_path     TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      extractor     TEXT NOT NULL,
      indexed_at    INTEGER NOT NULL,
      PRIMARY KEY (project_root, file_path)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id     TEXT PRIMARY KEY,
      project_root   TEXT NOT NULL,
      started_at     INTEGER NOT NULL,
      ended_at       INTEGER NOT NULL,
      duration_secs  INTEGER NOT NULL,
      branch         TEXT NOT NULL,
      summary        TEXT NOT NULL,
      files_created  TEXT NOT NULL DEFAULT '[]',
      files_modified TEXT NOT NULL DEFAULT '[]',
      commands_run   TEXT NOT NULL DEFAULT '[]',
      message_count  INTEGER NOT NULL DEFAULT 0,
      ai_title       TEXT,
      created_at     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_by_project
      ON sessions (project_root, started_at DESC);

    CREATE TABLE IF NOT EXISTS session_reads (
      session_id    TEXT NOT NULL,
      file_path     TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      first_read_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, file_path)
    );
  `);

  // Phase 7 migration: add read tracking columns if not present
  try {
    db.exec("ALTER TABLE session_reads ADD COLUMN read_count INTEGER NOT NULL DEFAULT 1");
    db.exec("ALTER TABLE session_reads ADD COLUMN last_read_at INTEGER NOT NULL DEFAULT 0");
  } catch { /* columns already exist */ }

  // Phase 9e migration: add decision excerpts column
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN decisions TEXT NOT NULL DEFAULT '[]'");
  } catch { /* column already exists */ }

  // Phase 23 migration: add closing_notes column (replaces keyword-regex decisions)
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN closing_notes TEXT NOT NULL DEFAULT '[]'");
  } catch { /* column already exists */ }

  // Phase 14 migration: add audit columns to project_index
  try {
    db.exec("ALTER TABLE project_index ADD COLUMN audit_json TEXT");
    db.exec("ALTER TABLE project_index ADD COLUMN audit_md TEXT");
    db.exec("ALTER TABLE project_index ADD COLUMN audited_at INTEGER");
  } catch { /* columns already exist */ }

  // Phase 18b: compaction event log
  db.exec(`
    CREATE TABLE IF NOT EXISTS compaction_events (
      project_root TEXT NOT NULL,
      compacted_at INTEGER NOT NULL
    )
  `);

  // Phase 19: named script library
  db.exec(`
    CREATE TABLE IF NOT EXISTS command_runs (
      project_root  TEXT NOT NULL,
      command_hash  TEXT NOT NULL,
      command       TEXT NOT NULL,
      run_count     INTEGER NOT NULL DEFAULT 1,
      last_run_at   INTEGER NOT NULL,
      PRIMARY KEY (project_root, command_hash)
    );

    CREATE TABLE IF NOT EXISTS saved_commands (
      project_root  TEXT NOT NULL,
      name          TEXT NOT NULL,
      script        TEXT NOT NULL,
      description   TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      run_count     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_root, name)
    );
  `);
  try {
    getDb().prepare("ALTER TABLE saved_commands ADD COLUMN last_failed_at INTEGER").run();
  } catch { /* column already exists */ }
}

export function getStoredIndex(projectRoot: string): { index_json: string; index_md: string; built_at: number } | null {
  const row = getDb()
    .prepare("SELECT index_json, index_md, built_at FROM project_index WHERE project_root = ?")
    .get(projectRoot) as { index_json: string; index_md: string; built_at: number } | undefined;
  return row ?? null;
}

export function saveIndex(projectRoot: string, indexJson: string, indexMd: string, fileCount: number): void {
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO project_index (project_root, index_json, index_md, built_at, file_count)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(projectRoot, indexJson, indexMd, Date.now(), fileCount);
}

export function getFileHash(projectRoot: string, filePath: string): string | null {
  const row = getDb()
    .prepare("SELECT content_hash FROM index_files WHERE project_root = ? AND file_path = ?")
    .get(projectRoot, filePath) as { content_hash: string } | undefined;
  return row?.content_hash ?? null;
}

export function saveFileHash(projectRoot: string, filePath: string, hash: string, extractor: string): void {
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO index_files (project_root, file_path, content_hash, extractor, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(projectRoot, filePath, hash, extractor, Date.now());
}

export function deleteFileEntry(projectRoot: string, filePath: string): void {
  getDb()
    .prepare("DELETE FROM index_files WHERE project_root = ? AND file_path = ?")
    .run(projectRoot, filePath);
}

export function saveSession(entry: SessionEntry): void {
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO sessions
        (session_id, project_root, started_at, ended_at, duration_secs,
         branch, summary, files_created, files_modified, commands_run,
         message_count, ai_title, closing_notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      entry.sessionId,
      entry.projectRoot,
      entry.startedAt,
      entry.endedAt,
      entry.durationSecs,
      entry.branch,
      entry.summary,
      JSON.stringify(entry.filesCreated),
      JSON.stringify(entry.filesModified),
      JSON.stringify(entry.commandsRun),
      entry.messageCount,
      entry.aiTitle ?? null,
      JSON.stringify(entry.closingNotes),
      entry.createdAt,
    );
  pruneOldSessions(entry.projectRoot, MAX_SESSIONS);
}

export function getRecentSessions(projectRoot: string, limit: number): SessionEntry[] {
  type Row = {
    session_id: string; project_root: string; started_at: number; ended_at: number;
    duration_secs: number; branch: string; summary: string; files_created: string;
    files_modified: string; commands_run: string; message_count: number;
    ai_title: string | null; closing_notes: string; created_at: number;
  };
  const rows = getDb()
    .prepare(`
      SELECT session_id, project_root, started_at, ended_at, duration_secs,
             branch, summary, files_created, files_modified, commands_run,
             message_count, ai_title, closing_notes, created_at
      FROM sessions WHERE project_root = ?
      ORDER BY started_at DESC LIMIT ?
    `)
    .all(projectRoot, limit) as Row[];

  return rows.map(r => ({
    sessionId: r.session_id,
    projectRoot: r.project_root,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationSecs: r.duration_secs,
    branch: r.branch,
    summary: r.summary,
    filesCreated: safeJsonParse(r.files_created),
    filesModified: safeJsonParse(r.files_modified),
    commandsRun: safeJsonParse(r.commands_run),
    messageCount: r.message_count,
    aiTitle: r.ai_title,
    closingNotes: safeJsonParse(r.closing_notes),
    createdAt: r.created_at,
  }));
}

export function pruneOldSessions(projectRoot: string, maxSessions: number): void {
  getDb()
    .prepare(`
      DELETE FROM sessions
      WHERE project_root = ?
        AND session_id NOT IN (
          SELECT session_id FROM sessions
          WHERE project_root = ?
          ORDER BY started_at DESC
          LIMIT ?
        )
    `)
    .run(projectRoot, projectRoot, maxSessions);
}

export function hasBeenRead(sessionId: string, filePath: string): { content_hash: string; read_count: number; first_read_at: number } | null {
  type Row = { content_hash: string; read_count: number; first_read_at: number };
  return (getDb()
    .prepare("SELECT content_hash, read_count, first_read_at FROM session_reads WHERE session_id = ? AND file_path = ?")
    .get(sessionId, filePath) as Row | undefined) ?? null;
}

export function recordRead(sessionId: string, filePath: string, contentHash: string): void {
  const now = Date.now();
  getDb()
    .prepare(`
      INSERT INTO session_reads (session_id, file_path, content_hash, read_count, first_read_at, last_read_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(session_id, file_path) DO UPDATE SET
        read_count = read_count + 1,
        last_read_at = excluded.last_read_at
    `)
    .run(sessionId, filePath, contentHash, now, now);
}

export function refreshSessionHash(sessionId: string, filePath: string, newHash: string): void {
  getDb()
    .prepare("UPDATE session_reads SET content_hash = ? WHERE session_id = ? AND file_path = ?")
    .run(newHash, sessionId, filePath);
}

export function getTopReadFiles(projectRoot: string, limit: number = 5): Array<{ file_path: string; session_count: number; total_reads: number }> {
  type Row = { file_path: string; session_count: number; total_reads: number };
  return getDb()
    .prepare(`
      SELECT sr.file_path,
             COUNT(DISTINCT sr.session_id) AS session_count,
             SUM(sr.read_count)            AS total_reads
      FROM session_reads sr
      JOIN sessions s ON sr.session_id = s.session_id
      WHERE s.project_root = ?
      GROUP BY sr.file_path
      ORDER BY session_count DESC, total_reads DESC
      LIMIT ?
    `)
    .all(projectRoot, limit) as Row[];
}

export function pruneOldSessionReads(maxAgeMs: number = 48 * 3600 * 1000): void {
  getDb()
    .prepare("DELETE FROM session_reads WHERE first_read_at < ?")
    .run(Date.now() - maxAgeMs);
}

export function getReadsSinceCompaction(
  projectRoot: string,
  since: number,
  limit: number = 15,
): Array<{ file_path: string; read_count: number }> {
  type Row = { file_path: string; read_count: number };
  return getDb()
    .prepare(`
      SELECT file_path, SUM(read_count) AS read_count
      FROM session_reads
      WHERE first_read_at > ?
        AND file_path LIKE ?
      GROUP BY file_path
      ORDER BY read_count DESC
      LIMIT ?
    `)
    .all(since, `${projectRoot}/%`, limit) as Row[];
}

export function saveAudit(projectRoot: string, auditJson: string, auditMd: string): void {
  getDb()
    .prepare("UPDATE project_index SET audit_json = ?, audit_md = ?, audited_at = ? WHERE project_root = ?")
    .run(auditJson, auditMd, Date.now(), projectRoot);
}

export function recordCompaction(projectRoot: string): void {
  getDb().prepare("INSERT INTO compaction_events (project_root, compacted_at) VALUES (?, ?)").run(projectRoot, Date.now());
}

export function getLastCompaction(projectRoot: string): number | null {
  const row = getDb()
    .prepare("SELECT MAX(compacted_at) as compacted_at FROM compaction_events WHERE project_root = ?")
    .get(projectRoot) as { compacted_at: number | null } | undefined;
  return row?.compacted_at ?? null;
}

export function resetSessionReadBaseline(sessionId: string, filePath: string): void {
  const now = Date.now();
  getDb()
    .prepare("UPDATE session_reads SET first_read_at = ?, last_read_at = ? WHERE session_id = ? AND file_path = ?")
    .run(now, now, sessionId, filePath);
}

export function getStoredAudit(projectRoot: string): { audit_md: string; audited_at: number } | null {
  type Row = { audit_md: string | null; audited_at: number | null };
  const row = getDb()
    .prepare("SELECT audit_md, audited_at FROM project_index WHERE project_root = ?")
    .get(projectRoot) as Row | undefined;
  if (!row || !row.audit_md || !row.audited_at) return null;
  return { audit_md: row.audit_md, audited_at: row.audited_at };
}

function safeJsonParse(s: string): string[] {
  try { return JSON.parse(s) as string[]; } catch { return []; }
}

// ── Phase 19: named script library ────────────────────────────────────────────

export function recordCommandRun(projectRoot: string, commandHash: string, command: string): void {
  const now = Date.now();
  getDb()
    .prepare(`
      INSERT INTO command_runs (project_root, command_hash, command, run_count, last_run_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(project_root, command_hash) DO UPDATE SET
        run_count = run_count + 1,
        last_run_at = excluded.last_run_at
    `)
    .run(projectRoot, commandHash, command, now);
}

export function getTopCommandRuns(
  projectRoot: string,
  limit: number,
  excludeScripts: string[] = [],
): Array<{ command: string; run_count: number }> {
  type Row = { command: string; run_count: number };
  const rows = getDb()
    .prepare(`
      SELECT command, run_count FROM command_runs
      WHERE project_root = ?
      ORDER BY run_count DESC LIMIT ?
    `)
    .all(projectRoot, limit * 2) as Row[];
  return rows.filter(r => !excludeScripts.includes(r.command)).slice(0, limit);
}

export function saveCommand(projectRoot: string, name: string, script: string, description: string): void {
  getDb()
    .prepare(`
      INSERT INTO saved_commands (project_root, name, script, description, created_at, run_count)
      VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(project_root, name) DO UPDATE SET
        script = excluded.script,
        description = excluded.description
    `)
    .run(projectRoot, name, script, description, Date.now());
}

export function getCommand(projectRoot: string, name: string): { script: string; description: string } | null {
  type Row = { script: string; description: string };
  return (getDb()
    .prepare("SELECT script, description FROM saved_commands WHERE project_root = ? AND name = ?")
    .get(projectRoot, name) as Row | undefined) ?? null;
}

export function getAllSavedCommands(projectRoot: string): Array<{ name: string; script: string; description: string; run_count: number; last_failed_at: number | null }> {
  type Row = { name: string; script: string; description: string; run_count: number; last_failed_at: number | null };
  return getDb()
    .prepare("SELECT name, script, description, run_count, last_failed_at FROM saved_commands WHERE project_root = ? ORDER BY run_count DESC, name ASC")
    .all(projectRoot) as Row[];
}

export function incrementSavedCommandRun(projectRoot: string, name: string): void {
  getDb()
    .prepare("UPDATE saved_commands SET run_count = run_count + 1 WHERE project_root = ? AND name = ?")
    .run(projectRoot, name);
}

export function deleteCommand(projectRoot: string, name: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM saved_commands WHERE project_root = ? AND name = ?")
    .run(projectRoot, name);
  return result.changes > 0;
}

export function updateLastFailed(projectRoot: string, name: string): void {
  getDb()
    .prepare("UPDATE saved_commands SET last_failed_at = ? WHERE project_root = ? AND name = ?")
    .run(Date.now(), projectRoot, name);
}

export function pruneOldCommandRuns(maxAgeMs: number = 30 * 24 * 3600 * 1000): void {
  getDb()
    .prepare("DELETE FROM command_runs WHERE last_run_at < ?")
    .run(Date.now() - maxAgeMs);
}
