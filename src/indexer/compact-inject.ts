import { relative, basename } from "path";
import { initIndexDb, getStoredIndex, getLastCompaction, getReadsSinceCompaction, getRecentSessions, getTopReadFiles, getAllSavedCommands } from "./db.js";
import { getGitState, formatGitState } from "./git.js";
import type { ProjectIndex, TsFunctionRef } from "./types.js";

export async function buildCompactInject(root: string): Promise<string> {
  initIndexDb();
  const sections: string[] = ["[augment-cc: compaction detected — re-injecting context]", ""];

  // TIER 1 — Non-reconstructable context (always inject)

  // Git state
  sections.push(formatGitState(getGitState(root)));

  // Last 2 session summaries
  const sessions = getRecentSessions(root, 2);
  if (sessions.length > 0) {
    sections.push("", "## Recent Sessions");
    for (const s of sessions) {
      const date = new Date(s.startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const title = s.aiTitle ?? s.summary.slice(0, 60);
      sections.push(`- ${date} (\`${s.branch}\`): ${title}`);
      if (s.closingNotes.length > 0) {
        const note = s.closingNotes[s.closingNotes.length - 1].slice(0, 120);
        sections.push(`  Concluded: "${note}"`);
      }
    }
  }

  // TIER 2 — Project structure (always inject, compact)
  const stored = getStoredIndex(root);
  let index: ProjectIndex | null = null;

  if (stored) {
    index = JSON.parse(stored.index_json) as ProjectIndex;
    const tree = index.fileTree;
    const frameworks = index.detectedTypes.length > 0 ? index.detectedTypes.join(", ") : "no recognized framework";
    sections.push("", `## Project (${tree.totalFiles} files — ${frameworks})`);
    const topDirs = tree.topDirs.slice(0, 4).join("  ");
    if (topDirs) sections.push(topDirs);
  }

  // Script Library — recover saved commands after compaction
  const saved = getAllSavedCommands(root);
  if (saved.length > 0) {
    sections.push("", "## Script Library");
    const MAX_SHOWN = 8;
    for (const s of saved.slice(0, MAX_SHOWN)) {
      const failNote = s.last_failed_at
        ? ` [last failed: ${Math.round((Date.now() - s.last_failed_at) / 3_600_000)}h ago]`
        : "";
      sections.push(`- \`${s.name}\` — ${s.description || s.script.slice(0, 50)}${failNote}`);
    }
    if (saved.length > MAX_SHOWN) sections.push(`- [+${saved.length - MAX_SHOWN} more — use list_commands()]`);
  }

  // TIER 3 — Active schemas from session_reads
  if (index) {
    const lastCompact = getLastCompaction(root) ?? 0;
    const reads = getReadsSinceCompaction(root, lastCompact);
    const readFiles = reads.map(r => r.file_path);

    if (readFiles.length > 0) {
      const sqlTables     = index.db.sqlTables.filter(t => readFiles.includes(t.sourceFile));
      const ormModels     = index.db.typeormModels.filter(m => readFiles.includes(m.sourceFile));
      const expressRoutes = index.routes.express.filter(r => readFiles.includes(r.sourceFile));
      const fastapiRoutes = index.routes.fastapi.filter(r => readFiles.includes(r.sourceFile));
      const tsInterfaces  = index.types.tsInterfaces.filter(t => readFiles.includes(t.sourceFile));
      const pythonSymbols = (index.python ?? []).filter(p => readFiles.includes(p.sourceFile));

      const hasPrisma  = readFiles.some(f => f.endsWith("schema.prisma") || f.includes(".prisma"));
      const hasDjango  = readFiles.some(f => f.endsWith("/models.py") || f.includes("/models/"));
      const hasGraphql = readFiles.some(f => f.endsWith(".graphql") || f.endsWith(".gql"));
      const hasRails   = readFiles.some(f => f.endsWith("config/routes.rb"));

      const prismaModels = hasPrisma  ? index.db.prismaModels    : [];
      const prismaEnums  = hasPrisma  ? index.db.prismaEnums     : [];
      const djangoModels = hasDjango  ? index.db.djangoModels    : [];
      const graphqlTypes = hasGraphql ? index.types.graphqlTypes : [];
      const railsRoutes  = hasRails   ? index.routes.rails       : [];

      const totalElements =
        sqlTables.length + ormModels.length + expressRoutes.length +
        fastapiRoutes.length + tsInterfaces.length + pythonSymbols.length +
        prismaModels.length + djangoModels.length + graphqlTypes.length + railsRoutes.length;

      if (totalElements > 0) {
        sections.push("", `## Active Schemas (${readFiles.length} file(s) accessed, ${totalElements} element(s))`);

        if (prismaModels.length > 0) {
          sections.push("", "### DB Schema (Prisma)");
          for (const m of prismaModels) {
            const fields = m.fields.slice(0, 6).map(f => `${f.name}: ${f.type}`).join(", ");
            sections.push(`- model ${m.name} { ${fields}${m.fields.length > 6 ? ` +${m.fields.length - 6} more` : ""} }`);
          }
          for (const e of prismaEnums) sections.push(`- enum ${e.name} { ${e.values.join(", ")} }`);
        }

        if (sqlTables.length > 0) {
          sections.push("", "### DB Schema (SQL)");
          for (const t of sqlTables) {
            const cols = t.columns.slice(0, 5).map(c => `${c.name}: ${c.type}`).join(", ");
            sections.push(`- ${t.tableName} (${cols}${t.columns.length > 5 ? ` +${t.columns.length - 5} more` : ""})`);
          }
        }

        if (djangoModels.length > 0) {
          sections.push("", "### DB Schema (Django)");
          for (const m of djangoModels) {
            const fields = m.fields.slice(0, 5).map(f => `${f.name}: ${f.fieldType}`).join(", ");
            sections.push(`- class ${m.name}(Model): ${fields}`);
          }
        }

        if (ormModels.length > 0) {
          sections.push("", "### DB Schema (ORM)");
          for (const m of ormModels) sections.push(`- @Entity ${m.name} [${m.framework}]`);
        }

        if (expressRoutes.length > 0) {
          sections.push("", "### Routes (Express)");
          for (const r of expressRoutes) sections.push(`- ${r.method.toUpperCase()} ${r.path}`);
        }

        if (fastapiRoutes.length > 0) {
          sections.push("", "### Routes (FastAPI)");
          for (const r of fastapiRoutes) sections.push(`- ${r.method.toUpperCase()} ${r.path}`);
        }

        if (railsRoutes.length > 0) {
          sections.push("", "### Routes (Rails)");
          for (const r of railsRoutes) sections.push(`- ${r.method.toUpperCase()} ${r.path} → ${r.action}`);
        }

        if (tsInterfaces.length > 0) {
          sections.push("", "### TypeScript Types");
          for (const t of tsInterfaces) {
            const members = t.members.slice(0, 4).map(m => `${m.name}: ${m.type}`).join(", ");
            sections.push(`- ${t.kind} ${t.name} { ${members}${t.members.length > 4 ? ` +${t.members.length - 4} more` : ""} }`);
          }
        }

        if (pythonSymbols.length > 0) {
          sections.push("", "### Python");
          for (const p of pythonSymbols) sections.push(`- ${p.kind} ${p.name}`);
        }

        if (graphqlTypes.length > 0) {
          sections.push("", "### GraphQL");
          for (const t of graphqlTypes) sections.push(`- ${t.keyword} ${t.name}`);
        }
      }
    }
  }

  // TIER 4 — Symbol maps for top-5 hot files
  if (index) {
    const tsFunctions: TsFunctionRef[] = (index.types as ProjectIndex["types"] & { tsFunctions?: TsFunctionRef[] }).tsFunctions ?? [];
    if (tsFunctions.length > 0) {
      const hotFiles = getTopReadFiles(root, 5);
      const hotWithFns = hotFiles
        .map(hf => ({ ...hf, fns: tsFunctions.filter(f => f.sourceFile === hf.file_path) }))
        .filter(hf => hf.fns.length > 0);

      if (hotWithFns.length > 0) {
        sections.push("", `## Hot File Symbol Maps (${hotWithFns.length} file(s))`);
        for (const hf of hotWithFns) {
          const rel = relative(root, hf.file_path) || basename(hf.file_path);
          const fnList = hf.fns.slice(0, 8).map(f => `${f.name} [${f.startLine}-${f.endLine}]`).join(" | ");
          const extra = hf.fns.length > 8 ? ` [+${hf.fns.length - 8} more]` : "";
          sections.push(`- ${rel} (${hf.session_count} sessions): ${fnList}${extra}`);
        }
      }
    }
  }

  return sections.join("\n");
}
