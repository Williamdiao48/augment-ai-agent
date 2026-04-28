import type { PrismaModel, PrismaEnum } from "../types.js";

const PRISMA_SCALARS = new Set([
  "String", "Int", "Boolean", "Float", "DateTime",
  "Json", "Bytes", "Decimal", "BigInt",
]);

export function extractPrisma(content: string): { models: PrismaModel[]; enums: PrismaEnum[] } {
  const models: PrismaModel[] = [];
  const enums: PrismaEnum[] = [];

  const lines = content.split("\n");
  let mode: "none" | "model" | "enum" = "none";
  let current: PrismaModel | PrismaEnum | null = null;

  for (const raw of lines) {
    const line = raw.trim();

    if (mode === "none") {
      const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
      if (modelMatch) {
        mode = "model";
        current = { name: modelMatch[1], fields: [] };
        continue;
      }
      const enumMatch = line.match(/^enum\s+(\w+)\s*\{/);
      if (enumMatch) {
        mode = "enum";
        current = { name: enumMatch[1], values: [] };
        continue;
      }
    }

    if (mode === "model" && current) {
      if (line === "}") {
        models.push(current as PrismaModel);
        current = null;
        mode = "none";
        continue;
      }
      if (line.startsWith("@@") || line.startsWith("//") || line === "") continue;

      const fieldMatch = line.match(/^(\w+)\s+(\w+)(\[\])?\s*(\?)?/);
      if (fieldMatch) {
        const type = fieldMatch[2];
        (current as PrismaModel).fields.push({
          name: fieldMatch[1],
          type,
          isArray: !!fieldMatch[3],
          isOptional: !!fieldMatch[4],
          isRelation: !PRISMA_SCALARS.has(type),
        });
      }
    }

    if (mode === "enum" && current) {
      if (line === "}") {
        enums.push(current as PrismaEnum);
        current = null;
        mode = "none";
        continue;
      }
      if (line && !line.startsWith("//")) {
        (current as PrismaEnum).values.push(line.split(/\s/)[0]);
      }
    }
  }

  return { models, enums };
}
