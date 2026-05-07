import { basename, relative } from "path";
import type { ProjectIndex } from "./types.js";

const MAX_MODELS = Number(process.env.AUGMENT_CC_MAX_MODELS ?? 20);
const MAX_FIELDS = 6;
const MAX_ROUTES = 8;
const MAX_TYPES = 10;
const MAX_TYPE_MEMBERS = 4;
const MAX_GQL_FIELDS = 4;
const MAX_PYTHON_FILES = 10;
const MAX_PYTHON_SYMBOLS_PER_FILE = 5;
const MAX_GENERIC_FILES = 10;
const MAX_GENERIC_PER_FILE = 5;
const MAX_ENV = 20;
const PLACEHOLDER_RE = /^(?:your[-_]|<[^>]+>|x{3,}|change[-_]?me|placeholder|todo|replace|example\.com)/i;

function more(n: number): string {
  return n > 0 ? ` [+${n} more]` : "";
}

function truncateList<T>(arr: T[], max: number): { shown: T[]; rest: number } {
  return { shown: arr.slice(0, max), rest: Math.max(0, arr.length - max) };
}

export function formatIndex(index: ProjectIndex): string {
  const sections: string[] = [];

  sections.push(
    `# Project Index`,
    `Root: \`${index.projectRoot}\` | Files: ${index.fileTree.totalFiles} | Built: ${new Date(index.builtAt).toISOString()}`,
  );

  // --- DB Schema ---
  const { db } = index;
  const hasDb =
    db.prismaModels.length || db.sqlTables.length || db.djangoModels.length || db.typeormModels.length;

  if (hasDb) {
    sections.push("", "## Database Schema");

    if (db.prismaModels.length) {
      const { shown, rest } = truncateList(db.prismaModels, MAX_MODELS);
      sections.push(`**Prisma** (${db.prismaModels.length} models${more(rest)}):`);
      for (const m of shown) {
        const { shown: fields, rest: fr } = truncateList(m.fields, MAX_FIELDS);
        const fieldStr = fields.map((f) => `${f.name}(${f.type}${f.isArray ? "[]" : ""}${f.isOptional ? "?" : ""})`).join(", ");
        sections.push(`- ${m.name}: ${fieldStr}${more(fr)}`);
      }
      if (db.prismaEnums?.length) {
        sections.push(`Enums: ${db.prismaEnums.map((e) => e.name).join(", ")}`);
      }
    }

    if (db.djangoModels.length) {
      const { shown, rest } = truncateList(db.djangoModels, MAX_MODELS);
      sections.push(`**Django** (${db.djangoModels.length} models${more(rest)}):`);
      for (const m of shown) {
        const { shown: fields, rest: fr } = truncateList(m.fields, MAX_FIELDS);
        const fieldStr = fields.map((f) => `${f.name}(${f.fieldType})`).join(", ");
        sections.push(`- ${m.name}: ${fieldStr}${more(fr)}`);
      }
    }

    if (db.sqlTables.length) {
      sections.push(`**SQL Tables** (${db.sqlTables.length}): ${db.sqlTables.map((t) => t.tableName).join(", ")}`);
    }

    if (db.typeormModels.length) {
      const { shown, rest } = truncateList(db.typeormModels, MAX_MODELS);
      sections.push(`**ORM** (${db.typeormModels.length} entities${more(rest)}):`);
      for (const m of shown) {
        const { shown: fields, rest: fr } = truncateList(m.fields, MAX_FIELDS);
        sections.push(`- ${m.name}: ${fields.map((f) => f.name).join(", ")}${more(fr)}`);
      }
    }
  }

  // --- Python Symbols ---
  if (index.python.length) {
    const byFile = new Map<string, typeof index.python>();
    for (const sym of index.python) {
      const key = sym.sourceFile;
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(sym);
    }
    const totalClasses = index.python.filter((s) => s.kind === "class").length;
    const totalFns = index.python.filter((s) => s.kind === "function").length;
    const fileCount = byFile.size;
    const fileRest = Math.max(0, fileCount - MAX_PYTHON_FILES);
    sections.push("", `## Python Symbols (${totalClasses} classes, ${totalFns} functions across ${fileCount} files${fileRest > 0 ? ` [+${fileRest} more files]` : ""})`);

    let filesShown = 0;
    for (const [filePath, syms] of byFile) {
      if (filesShown >= MAX_PYTHON_FILES) break;
      filesShown++;
      const rel = relative(index.projectRoot, filePath) || basename(filePath);
      const parts: string[] = [];
      let symCount = 0;
      let extraSyms = 0;
      for (const sym of syms) {
        if (symCount >= MAX_PYTHON_SYMBOLS_PER_FILE) { extraSyms++; continue; }
        symCount++;
        if (sym.kind === "function") {
          parts.push(`def ${sym.name}`);
        } else {
          const { shown: methods, rest: mr } = truncateList(sym.methods, 4);
          const methodNames = methods.map((m) => m.name).join(", ");
          parts.push(`${sym.name}${methods.length ? ` [${methodNames}${mr > 0 ? `, +${mr} more` : ""}]` : ""}`);
        }
      }
      const suffix = extraSyms > 0 ? ` [+${extraSyms} more]` : "";
      sections.push(`- ${rel}: ${parts.join(", ")}${suffix}`);
    }
  }

  // --- API Routes ---
  const { routes } = index;
  const allRoutes = [
    ...routes.express.map((r) => ({ ...r, source: "Express" })),
    ...routes.nextjs.map((r) => ({ ...r, source: `Next.js (${r.routerType})` })),
    ...routes.fastapi.map((r) => ({ ...r, source: "FastAPI" })),
    ...routes.rails.map((r) => ({ ...r, source: "Rails" })),
  ];

  if (allRoutes.length) {
    sections.push("", "## API Routes");

    const bySource: Record<string, typeof allRoutes> = {};
    for (const r of allRoutes) {
      bySource[r.source] = bySource[r.source] ?? [];
      bySource[r.source].push(r);
    }

    for (const [source, rs] of Object.entries(bySource)) {
      const { shown, rest } = truncateList(rs, MAX_ROUTES);
      sections.push(`**${source}** (${rs.length} routes):`);
      for (const r of shown) {
        sections.push(`- ${r.method.padEnd(6)} ${r.path}`);
      }
      if (rest > 0) sections.push(`- [+${rest} more]`);
    }
  }

  // --- TypeScript Types ---
  const { types } = index;
  if (types.tsInterfaces.length) {
    const { shown, rest } = truncateList(
      [...types.tsInterfaces].sort((a, b) => b.members.length - a.members.length),
      MAX_TYPES
    );
    sections.push("", `## TypeScript Types (${types.tsInterfaces.length} exported${more(rest)})`);
    for (const t of shown) {
      const { shown: members, rest: mr } = truncateList(t.members, MAX_TYPE_MEMBERS);
      const memberStr = members.map((m) => `${m.name}: ${m.type}`).join(", ");
      sections.push(`- ${t.kind} ${t.name} { ${memberStr}${mr > 0 ? `, +${mr} more` : ""} }`);
    }
  }

  // --- GraphQL ---
  if (types.graphqlTypes.length) {
    sections.push("", `## GraphQL Schema (${types.graphqlTypes.length} types)`);
    for (const t of types.graphqlTypes) {
      const { shown: fields, rest: fr } = truncateList(t.fields, MAX_GQL_FIELDS);
      const fieldStr = fields.map((f) => `${f.name}: ${f.type}`).join(", ");
      sections.push(`- ${t.keyword} ${t.name} { ${fieldStr}${more(fr)} }`);
    }
  }

  // --- Env ---
  if (index.env.length) {
    sections.push("", `## Environment Variables (${index.env.length} keys)`);
    const secrets = index.env.filter((e) => e.isSecret);
    if (secrets.length) {
      const { shown: shownS, rest: restS } = truncateList(secrets, MAX_ENV);
      sections.push(`Secrets (${secrets.length}): ${shownS.map((e) => e.name).join(", ")}${restS > 0 ? ` [+${restS} more]` : ""}`);
    }
    const withDefaults = index.env.filter((e) => !e.isSecret && e.defaultValue !== null && !PLACEHOLDER_RE.test(e.defaultValue!));
    if (withDefaults.length) {
      const { shown: shownD, rest: restD } = truncateList(withDefaults, MAX_ENV);
      sections.push(`With defaults: ${shownD.map((e) => `${e.name}=${e.defaultValue}`).join(", ")}${restD > 0 ? ` [+${restD} more]` : ""}`);
    }
  }

  // --- Docker ---
  if (index.docker.length) {
    sections.push("", `## Docker Services (${index.docker.length})`);
    for (const s of index.docker) {
      const ports = s.ports.length ? ` → ${s.ports.join(", ")}` : "";
      const deps = s.dependsOn.length ? ` [needs: ${s.dependsOn.join(", ")}]` : "";
      sections.push(`- ${s.name} (${s.image})${ports}${deps}`);
    }
  }

  // --- Generic Declarations ---
  if (index.declarations.length) {
    const byFile = new Map<string, typeof index.declarations>();
    for (const sym of index.declarations) {
      if (!byFile.has(sym.sourceFile)) byFile.set(sym.sourceFile, []);
      byFile.get(sym.sourceFile)!.push(sym);
    }
    const extLangMap: Record<string, string> = {
      ".go": "Go", ".rs": "Rust", ".java": "Java", ".rb": "Ruby",
      ".cpp": "C++", ".hpp": "C++", ".c": "C", ".h": "C/C++",
      ".kt": "Kotlin", ".php": "PHP", ".cs": "C#", ".swift": "Swift",
      ".scala": "Scala", ".ex": "Elixir", ".exs": "Elixir",
    };
    const langCounts: Record<string, number> = {};
    for (const sym of index.declarations) {
      const ext = sym.sourceFile.slice(sym.sourceFile.lastIndexOf("."));
      const lang = extLangMap[ext] ?? ext;
      langCounts[lang] = (langCounts[lang] ?? 0) + 1;
    }
    const langs = Object.entries(langCounts).sort((a, b) => b[1] - a[1]).map(([l]) => l).join(", ");
    const fileRest = Math.max(0, byFile.size - MAX_GENERIC_FILES);
    sections.push("", `## Declarations (${langs} — ${byFile.size} files, ${index.declarations.length} symbols${fileRest > 0 ? ` [+${fileRest} more files]` : ""})`);

    let filesShown = 0;
    for (const [filePath, syms] of byFile) {
      if (filesShown >= MAX_GENERIC_FILES) break;
      filesShown++;
      const rel = relative(index.projectRoot, filePath) || basename(filePath);
      const { shown, rest } = truncateList(syms, MAX_GENERIC_PER_FILE);
      const symStr = shown.map((s) => `${s.keyword} ${s.name}`).join(", ");
      sections.push(`- ${rel}: ${symStr}${rest > 0 ? ` [+${rest} more]` : ""}`);
    }
  }

  // --- File Tree ---
  const { fileTree } = index;
  sections.push("", "## File Tree");
  if (fileTree.topDirs.length) sections.push(`Dirs: ${fileTree.topDirs.join("  ")}`);
  const extSummary = Object.entries(fileTree.byExtension)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, n]) => `${ext}(${n})`)
    .join("  ");
  if (extSummary) sections.push(`Exts: ${extSummary}`);

  return sections.join("\n");
}
