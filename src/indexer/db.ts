import { getDb } from "../cache.js";

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
  `);
}

export function getStoredIndex(projectRoot: string): { index_json: string; index_md: string } | null {
  const row = getDb()
    .prepare("SELECT index_json, index_md FROM project_index WHERE project_root = ?")
    .get(projectRoot) as { index_json: string; index_md: string } | undefined;
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
