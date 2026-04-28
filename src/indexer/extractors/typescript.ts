import { readFile } from "fs/promises";
import { basename, dirname } from "path";
import ts from "typescript";
import type { TsInterface, TsMember } from "../types.js";

const TYPE_DIR_RE = /\/(types?|interfaces?|models?|schemas?|shared)\//i;
const TYPE_FILE_RE = /\.(types?|interfaces?|schema|dto|model)\.(tsx?|jsx?)$/i;
const MAX_FILES = 50;
const MAX_FILE_BYTES = 50_000;

export function isHighValueTypeFile(filePath: string): boolean {
  const name = basename(filePath);
  if (/^(types?|interfaces?|schema)\.tsx?$/.test(name)) return true;
  if (TYPE_FILE_RE.test(name)) return true;
  if (TYPE_DIR_RE.test(filePath)) return true;
  return false;
}

function getMemberType(node: ts.TypeElement | ts.EnumMember, src: ts.SourceFile): string {
  if (ts.isPropertySignature(node) && node.type) {
    return node.type.getText(src);
  }
  return "unknown";
}

export async function extractTypescript(files: string[]): Promise<TsInterface[]> {
  const results: TsInterface[] = [];
  let processed = 0;

  for (const filePath of files) {
    if (processed >= MAX_FILES) break;

    let content: string;
    try {
      const buf = await readFile(filePath);
      if (buf.length > MAX_FILE_BYTES) continue;
      content = buf.toString("utf-8");
    } catch {
      continue;
    }

    processed++;

    const src = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    for (const node of src.statements) {
      if (ts.isInterfaceDeclaration(node)) {
        const isExportedNode =
          !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export);
        if (!isExportedNode) continue;
        const members: TsMember[] = node.members
          .filter(ts.isPropertySignature)
          .map((m) => ({
            name: m.name.getText(src),
            type: getMemberType(m, src),
          }));
        results.push({ name: node.name.text, kind: "interface", members, sourceFile: filePath });
        continue;
      }

      if (ts.isTypeAliasDeclaration(node)) {
        const isExportedNode =
          !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export);
        if (!isExportedNode) continue;
        const members: TsMember[] = [];
        if (ts.isTypeLiteralNode(node.type)) {
          node.type.members.filter(ts.isPropertySignature).forEach((m) => {
            members.push({ name: m.name.getText(src), type: getMemberType(m, src) });
          });
        }
        results.push({ name: node.name.text, kind: "type", members, sourceFile: filePath });
      }
    }
  }

  return results;
}
