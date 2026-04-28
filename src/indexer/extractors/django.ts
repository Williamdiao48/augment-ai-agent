import type { DjangoModel } from "../types.js";

const FIELD_RE = /^\s{4,}(\w+)\s*=\s*models\.([\w]+)\s*\(/;
const CLASS_RE = /^class\s+(\w+)\s*\(([^)]+)\)\s*:/;

export function extractDjango(content: string): DjangoModel[] {
  const models: DjangoModel[] = [];
  const lines = content.split("\n");

  let current: DjangoModel | null = null;
  let classIndent = 0;

  for (const raw of lines) {
    const classMatch = raw.match(CLASS_RE);
    if (classMatch) {
      const parents = classMatch[2].split(",").map((s) => s.trim());
      if (parents.some((p) => p === "models.Model" || p === "Model")) {
        if (current) models.push(current);
        current = { name: classMatch[1], fields: [] };
        classIndent = raw.search(/\S/);
      } else {
        if (current) models.push(current);
        current = null;
      }
      continue;
    }

    if (!current) continue;

    const lineIndent = raw.search(/\S/);
    if (raw.trim() === "") continue;

    // Back to class level or less — class ended
    if (lineIndent <= classIndent && raw.trim() !== "") {
      models.push(current);
      current = null;
      continue;
    }

    const fieldMatch = raw.match(FIELD_RE);
    if (fieldMatch) {
      current.fields.push({ name: fieldMatch[1], fieldType: fieldMatch[2] });
    }
  }

  if (current) models.push(current);
  return models;
}
