import type { GenericSymbol } from "../types.js";

const MAX_PER_FILE = 50;

// Matches declaration keywords after optional visibility/modifier prefixes.
// Covers Go (func, type+struct/interface), Rust (fn, struct, enum, trait, impl),
// Java/Kotlin/C# (class, interface, enum, record, fun, object), Swift (class, struct,
// enum, protocol, actor, func), Ruby (class, module, def), C++ (class, struct),
// Elixir (defmodule, def, defp), and others.
const DECL_RE =
  /^\s*(?:(?:pub(?:\(crate\))?|public|private|protected|internal|fileprivate|open|abstract|final|sealed|data|async|unsafe|static|override|inline|extern|export)\s+)*\b(class|interface|struct|enum|trait|union|record|module|object|protocol|actor|namespace|fn|func|def|fun|defmodule|defp)\b\s+([A-Za-z_]\w*)/;

export function extractGenericDeclarations(
  content: string,
  sourceFile: string,
): GenericSymbol[] {
  const symbols: GenericSymbol[] = [];
  for (const line of content.split("\n")) {
    if (symbols.length >= MAX_PER_FILE) break;
    const m = line.match(DECL_RE);
    if (m) symbols.push({ keyword: m[1], name: m[2], sourceFile });
  }
  return symbols;
}
