import Database from "better-sqlite3";
import { createHash } from "crypto";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import os from "os";

const CACHE_DIR = join(os.homedir(), ".cache", "augment-cc");
const DB_PATH = join(CACHE_DIR, "cache.db");

export interface CacheEntry {
  key: string;
  value: string;
  content_hash: string | null;
  expires_at: number | null;
  created_at: number;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(CACHE_DIR, { recursive: true });
  db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      content_hash TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);

  return db;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function get(key: string): CacheEntry | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM cache WHERE key = ?")
    .get(key) as CacheEntry | undefined;

  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) {
    db.prepare("DELETE FROM cache WHERE key = ?").run(key);
    return null;
  }
  return row;
}

export function set(
  key: string,
  value: string,
  opts: { contentHash?: string; ttlMs?: number } = {}
): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO cache (key, value, content_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    key,
    value,
    opts.contentHash ?? null,
    opts.ttlMs ? Date.now() + opts.ttlMs : null,
    Date.now()
  );
}

export function invalidate(key: string): void {
  getDb().prepare("DELETE FROM cache WHERE key = ?").run(key);
}

export function stats(): { total: number; expired: number } {
  const db = getDb();
  const total = (db.prepare("SELECT COUNT(*) as n FROM cache").get() as { n: number }).n;
  const expired = (
    db
      .prepare("SELECT COUNT(*) as n FROM cache WHERE expires_at IS NOT NULL AND expires_at < ?")
      .get(Date.now()) as { n: number }
  ).n;
  return { total, expired };
}
