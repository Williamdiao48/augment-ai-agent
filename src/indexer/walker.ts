import { readdir, readFile, access } from "fs/promises";
import { join, relative, extname, basename } from "path";
import ignore, { Ignore } from "ignore";
import type { FileTreeSummary } from "./types.js";

const ALWAYS_IGNORE = [
  "node_modules", "dist", ".git", ".next", "__pycache__",
  "*.pyc", "build", "coverage", ".cache", "*.egg-info",
  ".venv", "venv", ".DS_Store", "*.lock",
];

export async function buildIgnore(root: string): Promise<Ignore> {
  const ig = ignore();
  ig.add(ALWAYS_IGNORE);

  try {
    const gitignore = await readFile(join(root, ".gitignore"), "utf-8");
    ig.add(gitignore);
  } catch {
    // no .gitignore — fine
  }

  return ig;
}

export async function walkProject(root: string, ig: Ignore): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);

      if (ig.ignores(rel)) continue;

      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        results.push(abs);
      }
    }
  }

  await walk(root);
  return results;
}

export function buildFileTree(files: string[], root: string): FileTreeSummary {
  const byExtension: Record<string, number> = {};
  const topDirCounts: Record<string, number> = {};

  for (const f of files) {
    const rel = relative(root, f);
    const ext = extname(f) || "(none)";
    byExtension[ext] = (byExtension[ext] ?? 0) + 1;

    const topDir = rel.split("/")[0];
    if (topDir && topDir !== basename(f)) {
      topDirCounts[topDir] = (topDirCounts[topDir] ?? 0) + 1;
    }
  }

  const topDirs = Object.entries(topDirCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([dir, count]) => `${dir}/(${count})`);

  return { totalFiles: files.length, byExtension, topDirs };
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
