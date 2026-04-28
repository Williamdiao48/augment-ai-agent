import type { GraphqlType } from "../types.js";

export function extractGraphql(content: string): GraphqlType[] {
  const types: GraphqlType[] = [];
  const lines = content.split("\n");

  let current: GraphqlType | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    if (!current) {
      const blockMatch = line.match(/^(?:extend\s+)?(type|interface|input|enum|union|scalar)\s+(\w+)/);
      if (blockMatch) {
        current = { keyword: blockMatch[1], name: blockMatch[2], fields: [] };
      }
      continue;
    }

    if (line === "}") {
      types.push(current);
      current = null;
      continue;
    }

    // Field: name(args?): Type
    const fieldMatch = line.match(/^(\w+)\s*(?:\([^)]*\))?\s*:\s*([^\n#]+)/);
    if (fieldMatch) {
      current.fields.push({ name: fieldMatch[1], type: fieldMatch[2].trim() });
    }
  }

  return types;
}
