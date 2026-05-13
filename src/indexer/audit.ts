import { readFileSync } from "fs";
import { relative, extname } from "path";
import { buildIgnore, walkProject } from "./walker.js";
import { getStoredIndex } from "./db.js";
import type { ProjectIndex } from "./types.js";

const OVERSIZED_LINES = Number(process.env.AUGMENT_CC_AUDIT_OVERSIZED_LINES ?? 300);
const HIGH_EXPORTS    = Number(process.env.AUGMENT_CC_AUDIT_HIGH_EXPORTS ?? 15);
const MAX_SHOWN = 10;

const COMMON_NAMES = new Set([
  "index", "default", "main", "App", "Error", "handler",
  "init", "create", "get", "set", "update", "delete", "router",
  "middleware", "config", "setup", "connect", "run", "start", "stop",
]);

const FUNCTION_KEYWORDS = new Set(["function", "func", "fn", "def", "fun", "sub", "method"]);

const TS_EXPORT_FN_RE = /^export\s+(?:async\s+)?function\s+(\w+)/gm;
const TS_EXPORT_ARROW_RE = /^export\s+const\s+(\w+)\s*=\s*(?:async\s+)?\(/gm;
const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"]);

// Only flag these extensions as oversized — skip generated/data/config files
const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs",
  ".py", ".go", ".rs", ".java", ".kt", ".cs", ".swift",
  ".rb", ".ex", ".exs", ".php", ".c", ".cpp", ".h", ".hpp",
]);

export interface AuditResult {
  analyzedCount: number;
  oversizedFiles: Array<{ path: string; lines: number }>;
  duplicateSymbols: Array<{ name: string; files: string[] }>;
  highExportFiles: Array<{ path: string; exportCount: number }>;
  auditedAt: number;
}

function recordSymbol(
  name: string,
  sourceFile: string,
  symbolsByFile: Map<string, Set<string>>,
  nameToFiles: Map<string, Set<string>>,
): void {
  if (!symbolsByFile.has(sourceFile)) symbolsByFile.set(sourceFile, new Set());
  symbolsByFile.get(sourceFile)!.add(name);
  if (!nameToFiles.has(name)) nameToFiles.set(name, new Set());
  nameToFiles.get(name)!.add(sourceFile);
}

export async function runCodeAudit(root: string): Promise<{ result: AuditResult; md: string | null } | null> {
  const stored = getStoredIndex(root);
  if (!stored) return null;

  const index = JSON.parse(stored.index_json) as ProjectIndex;

  const symbolsByFile = new Map<string, Set<string>>();
  const nameToFiles   = new Map<string, Set<string>>();

  // Track interface/type-only exports per file (for barrel file detection)
  const interfacesByFile = new Map<string, Set<string>>();
  for (const sym of index.types?.tsInterfaces ?? []) {
    if (!interfacesByFile.has(sym.sourceFile)) interfacesByFile.set(sym.sourceFile, new Set());
    interfacesByFile.get(sym.sourceFile)!.add(sym.name);
  }

  // From index: function-type declarations (Go, Rust, Java, Python, etc.)
  for (const sym of index.declarations ?? []) {
    if (FUNCTION_KEYWORDS.has(sym.keyword.toLowerCase())) {
      recordSymbol(sym.name, sym.sourceFile, symbolsByFile, nameToFiles);
    }
  }
  for (const sym of index.python ?? []) {
    if (sym.kind === "function") {
      recordSymbol(sym.name, sym.sourceFile, symbolsByFile, nameToFiles);
    }
  }
  // TypeScript interfaces/types (not functions, but useful for high-export detection)
  for (const sym of index.types?.tsInterfaces ?? []) {
    recordSymbol(sym.name, sym.sourceFile, symbolsByFile, nameToFiles);
  }

  // File scan: line counts + TS/JS exported function names
  const ig = await buildIgnore(root);
  const files = await walkProject(root, ig);
  const oversizedFiles: AuditResult["oversizedFiles"] = [];
  let analyzedCount = 0;

  for (const absPath of files) {
    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }
    analyzedCount++;
    const lineCount = content.split("\n").length;
    if (lineCount > OVERSIZED_LINES && SOURCE_EXTS.has(extname(absPath))) {
      oversizedFiles.push({ path: relative(root, absPath), lines: lineCount });
    }

    if (TS_EXTS.has(extname(absPath))) {
      for (const m of content.matchAll(TS_EXPORT_FN_RE)) {
        recordSymbol(m[1], absPath, symbolsByFile, nameToFiles);
      }
      for (const m of content.matchAll(TS_EXPORT_ARROW_RE)) {
        recordSymbol(m[1], absPath, symbolsByFile, nameToFiles);
      }
    }
  }

  oversizedFiles.sort((a, b) => b.lines - a.lines);

  const duplicateSymbols: AuditResult["duplicateSymbols"] = [];
  for (const [name, filesSet] of nameToFiles) {
    if (filesSet.size >= 2 && !COMMON_NAMES.has(name)) {
      duplicateSymbols.push({
        name,
        files: [...filesSet].map(f => relative(root, f)),
      });
    }
  }
  duplicateSymbols.sort((a, b) => b.files.length - a.files.length);

  const highExportFiles: AuditResult["highExportFiles"] = [];
  for (const [absPath, syms] of symbolsByFile) {
    if (syms.size > HIGH_EXPORTS) {
      const interfaceCount = interfacesByFile.get(absPath)?.size ?? 0;
      if (interfaceCount / syms.size > 0.8) continue; // barrel file — skip
      highExportFiles.push({ path: relative(root, absPath), exportCount: syms.size });
    }
  }
  highExportFiles.sort((a, b) => b.exportCount - a.exportCount);

  const result: AuditResult = {
    analyzedCount,
    oversizedFiles: oversizedFiles.slice(0, MAX_SHOWN),
    duplicateSymbols: duplicateSymbols.slice(0, MAX_SHOWN),
    highExportFiles: highExportFiles.slice(0, MAX_SHOWN),
    auditedAt: Date.now(),
  };

  const md = formatAuditInjectMd(result);
  return { result, md };
}

function formatAuditInjectMd(result: AuditResult): string | null {
  const sections: string[] = [];

  if (result.oversizedFiles.length > 0) {
    const lines = [`**Oversized files** (>${OVERSIZED_LINES} lines — consider splitting):`];
    for (const f of result.oversizedFiles) {
      lines.push(`- \`${f.path}\` — ${f.lines} lines`);
    }
    sections.push(lines.join("\n"));
  }

  if (result.duplicateSymbols.length > 0) {
    const lines = [`**Duplicate symbol names** (same name in 2+ files — possible redundancy):`];
    for (const d of result.duplicateSymbols) {
      lines.push(`- \`${d.name}\` — ${d.files.join(", ")}`);
    }
    sections.push(lines.join("\n"));
  }

  if (result.highExportFiles.length > 0) {
    const lines = [`**High-export files** (>${HIGH_EXPORTS} exports — possible utility dumping ground):`];
    for (const f of result.highExportFiles) {
      lines.push(`- \`${f.path}\` — ${f.exportCount} exports`);
    }
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) return null;
  return `## Code Health Warnings\n\n${sections.join("\n\n")}`;
}
