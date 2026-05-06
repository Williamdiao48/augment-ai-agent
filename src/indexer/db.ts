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
         message_count, ai_title, decisions, created_at)
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
      JSON.stringify(entry.decisions),
      entry.createdAt,
    );
  pruneOldSessions(entry.projectRoot, MAX_SESSIONS);
}

export function getRecentSessions(projectRoot: string, limit: number): SessionEntry[] {
  type Row = {
    session_id: string; project_root: string; started_at: number; ended_at: number;
    duration_secs: number; branch: string; summary: string; files_created: string;
    files_modified: string; commands_run: string; message_count: number;
    ai_title: string | null; decisions: string; created_at: number;
  };
  const rows = getDb()
    .prepare(`
      SELECT session_id, project_root, started_at, ended_at, duration_secs,
             branch, summary, files_created, files_modified, commands_run,
             message_count, ai_title, decisions, created_at
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
    decisions: safeJsonParse(r.decisions),
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

export function hasBeenRead(sessionId: string, filePath: string): { content_hash: string; read_count: number } | null {
  const row = getDb()
    .prepare("SELECT content_hash, read_count FROM session_reads WHERE session_id = ? AND file_path = ?")
    .get(sessionId, filePath) as { content_hash: string; read_count: number } | undefined;
  return row ?? null;
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

function safeJsonParse(s: string): string[] {
  try { return JSON.parse(s) as string[]; } catch { return []; }
}
