import type { SqlTable } from "../types.js";

const SKIP_PREFIXES = /^\s*(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|INDEX|KEY|FOREIGN\s+KEY|CHECK)/i;

export function extractSql(content: string, sourceFile: string): SqlTable[] {
  const tables: SqlTable[] = [];

  const tableRegex =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(\w+)[`"\]]?\s*\(([^;]+?)\)\s*;/gis;

  let match: RegExpExecArray | null;
  while ((match = tableRegex.exec(content)) !== null) {
    const tableName = match[1];
    const columnBlock = match[2];

    const columns = columnBlock
      .split(/,\s*\n/)
      .map((l) => l.trim())
      .filter((l) => l && !SKIP_PREFIXES.test(l))
      .flatMap((l) => {
        const col = l.match(/^`?"?(\w+)`?"?\s+([A-Z]+(?:\([^)]+\))?)/i);
        if (!col) return [];
        return [{ name: col[1], type: col[2].toUpperCase() }];
      });

    if (columns.length > 0) {
      tables.push({ tableName, columns, sourceFile });
    }
  }

  return tables;
}
