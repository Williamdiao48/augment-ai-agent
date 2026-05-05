import type { PythonSymbol } from "../types.js";

const MAX_METHODS_PER_CLASS = 10;
const MAX_SYMBOLS_PER_FILE = 50;

export function extractPython(content: string, sourceFile: string): PythonSymbol[] {
  const symbols: PythonSymbol[] = [];
  const lines = content.split("\n");
  let current: PythonSymbol | null = null;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const lineIndent = raw.search(/\S/);

    // Return to top-level scope — close current class
    if (current && lineIndent === 0) {
      symbols.push(current);
      current = null;
    }

    if (lineIndent === 0) {
      const classMatch = trimmed.match(/^class\s+(\w+)\s*(?:\([^)]*\))?\s*:/);
      if (classMatch) {
        if (current) symbols.push(current);
        current = { name: classMatch[1], kind: "class", methods: [], sourceFile };
        continue;
      }
      const fnMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
      if (fnMatch && !/^__\w+__$/.test(fnMatch[1])) {
        symbols.push({ name: fnMatch[1], kind: "function", methods: [], sourceFile });
        continue;
      }
    }

    // Method inside current class
    if (current && lineIndent > 0 && current.methods.length < MAX_METHODS_PER_CLASS) {
      const mMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\([^)]*\)(?:\s*->\s*([^:]+))?:/);
      if (mMatch && !/^__\w+__$/.test(mMatch[1])) {
        const ret = mMatch[2]?.trim() ?? "";
        const sig = ret
          ? `${mMatch[1]}(...) -> ${ret}`.slice(0, 80)
          : `${mMatch[1]}(...)`;
        current.methods.push({ name: mMatch[1], signature: sig });
      }
    }
  }

  if (current) symbols.push(current);
  return symbols.slice(0, MAX_SYMBOLS_PER_FILE);
}
