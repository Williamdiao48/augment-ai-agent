import { getStoredIndex, getLastCompaction, getReadsSinceCompaction } from "./db.js";
import { getGitState, formatGitState } from "./git.js";
import type { ProjectIndex } from "./types.js";

export async function buildCompactInject(root: string): Promise<string> {
  const lastCompact = getLastCompaction(root) ?? 0;
  const reads = getReadsSinceCompaction(root, lastCompact);
  const readFiles = reads.map(r => r.file_path);

  if (readFiles.length === 0) return "";

  const stored = getStoredIndex(root);
  const gitBlock = formatGitState(getGitState(root));

  if (!stored) return gitBlock;

  const index = JSON.parse(stored.index_json) as ProjectIndex;

  // Direct sourceFile cross-reference
  const sqlTables     = index.db.sqlTables.filter(t => readFiles.includes(t.sourceFile));
  const ormModels     = index.db.typeormModels.filter(m => readFiles.includes(m.sourceFile));
  const expressRoutes = index.routes.express.filter(r => readFiles.includes(r.sourceFile));
  const fastapiRoutes = index.routes.fastapi.filter(r => readFiles.includes(r.sourceFile));
  const tsInterfaces  = index.types.tsInterfaces.filter(t => readFiles.includes(t.sourceFile));
  const pythonSymbols = (index.python ?? []).filter(p => readFiles.includes(p.sourceFile));

  // Pattern-based fallback for types without sourceFile
  const hasPrisma  = readFiles.some(f => f.endsWith("schema.prisma") || f.includes(".prisma"));
  const hasDjango  = readFiles.some(f => f.endsWith("/models.py") || f.includes("/models/"));
  const hasGraphql = readFiles.some(f => f.endsWith(".graphql") || f.endsWith(".gql"));
  const hasRails   = readFiles.some(f => f.endsWith("config/routes.rb"));

  const prismaModels = hasPrisma  ? index.db.prismaModels        : [];
  const prismaEnums  = hasPrisma  ? index.db.prismaEnums         : [];
  const djangoModels = hasDjango  ? index.db.djangoModels        : [];
  const graphqlTypes = hasGraphql ? index.types.graphqlTypes     : [];
  const railsRoutes  = hasRails   ? index.routes.rails           : [];

  const totalElements =
    sqlTables.length + ormModels.length + expressRoutes.length +
    fastapiRoutes.length + tsInterfaces.length + pythonSymbols.length +
    prismaModels.length + djangoModels.length + graphqlTypes.length + railsRoutes.length;

  const header = `[augment-cc: post-compact targeted re-inject — ${readFiles.length} file(s) accessed, ${totalElements} schema element(s) retained]`;
  const sections: string[] = [header, "", gitBlock];

  if (prismaModels.length > 0) {
    sections.push("", "## DB Schema (Prisma — accessed this session)");
    for (const m of prismaModels) {
      const fields = m.fields.slice(0, 6).map(f => `${f.name}: ${f.type}`).join(", ");
      sections.push(`- model ${m.name} { ${fields}${m.fields.length > 6 ? ` +${m.fields.length - 6} more` : ""} }`);
    }
    for (const e of prismaEnums) {
      sections.push(`- enum ${e.name} { ${e.values.join(", ")} }`);
    }
  }

  if (sqlTables.length > 0) {
    sections.push("", "## DB Schema (SQL — accessed this session)");
    for (const t of sqlTables) {
      const cols = t.columns.slice(0, 5).map(c => `${c.name}: ${c.type}`).join(", ");
      sections.push(`- ${t.tableName} (${cols}${t.columns.length > 5 ? ` +${t.columns.length - 5} more` : ""})`);
    }
  }

  if (djangoModels.length > 0) {
    sections.push("", "## DB Schema (Django — accessed this session)");
    for (const m of djangoModels) {
      const fields = m.fields.slice(0, 5).map(f => `${f.name}: ${f.fieldType}`).join(", ");
      sections.push(`- class ${m.name}(Model): ${fields}`);
    }
  }

  if (ormModels.length > 0) {
    sections.push("", "## DB Schema (ORM — accessed this session)");
    for (const m of ormModels) sections.push(`- @Entity ${m.name} [${m.framework}]`);
  }

  if (expressRoutes.length > 0) {
    sections.push("", "## Routes (Express — accessed this session)");
    for (const r of expressRoutes) sections.push(`- ${r.method.toUpperCase()} ${r.path}`);
  }

  if (fastapiRoutes.length > 0) {
    sections.push("", "## Routes (FastAPI — accessed this session)");
    for (const r of fastapiRoutes) sections.push(`- ${r.method.toUpperCase()} ${r.path}`);
  }

  if (railsRoutes.length > 0) {
    sections.push("", "## Routes (Rails — accessed this session)");
    for (const r of railsRoutes) sections.push(`- ${r.method.toUpperCase()} ${r.path} → ${r.action}`);
  }

  if (tsInterfaces.length > 0) {
    sections.push("", "## TypeScript Types (accessed this session)");
    for (const t of tsInterfaces) {
      const members = t.members.slice(0, 4).map(m => `${m.name}: ${m.type}`).join(", ");
      sections.push(`- ${t.kind} ${t.name} { ${members}${t.members.length > 4 ? ` +${t.members.length - 4} more` : ""} }`);
    }
  }

  if (pythonSymbols.length > 0) {
    sections.push("", "## Python (accessed this session)");
    for (const p of pythonSymbols) sections.push(`- ${p.kind} ${p.name}`);
  }

  if (graphqlTypes.length > 0) {
    sections.push("", "## GraphQL (accessed this session)");
    for (const t of graphqlTypes) sections.push(`- ${t.keyword} ${t.name}`);
  }

  return sections.join("\n");
}
