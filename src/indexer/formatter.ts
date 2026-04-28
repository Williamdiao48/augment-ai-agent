import type { ProjectIndex } from "./types.js";

const MAX_MODELS = 10;
const MAX_FIELDS = 6;
const MAX_ROUTES = 8;
const MAX_TYPES = 10;
const MAX_TYPE_MEMBERS = 4;
const MAX_GQL_FIELDS = 4;

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
    const secrets = index.env.filter((e) => e.isSecret);
    const withDefaults = index.env.filter((e) => !e.isSecret && e.defaultValue !== null);
    sections.push("", `## Environment Variables (${index.env.length} keys)`);
    if (secrets.length) sections.push(`Secrets (${secrets.length}): ${secrets.map((e) => e.name).join(", ")}`);
    if (withDefaults.length) sections.push(`With defaults: ${withDefaults.map((e) => `${e.name}=${e.defaultValue}`).join(", ")}`);
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
