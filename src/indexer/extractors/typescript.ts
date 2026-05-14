import { readFile } from "fs/promises";
import { basename, dirname } from "path";
import ts from "typescript";
import type { TsInterface, TsMember, TsFunctionRef } from "../types.js";

const TYPE_DIR_RE = /\/(types?|interfaces?|models?|schemas?|shared)\//i;
const TYPE_FILE_RE = /\.(types?|interfaces?|schema|dto|model)\.(tsx?|jsx?)$/i;
const MAX_FILES = 50;
const MAX_FILE_BYTES = 50_000;
const MAX_FUNCTION_FILES = 100;
const MAX_FUNCTIONS_PER_FILE = 30;

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

export async function extractTsFunctions(files: string[]): Promise<TsFunctionRef[]> {
  const results: TsFunctionRef[] = [];
  let processed = 0;

  for (const filePath of files) {
    if (processed >= MAX_FUNCTION_FILES) break;

    let content: string;
    try {
      const buf = await readFile(filePath);
      if (buf.length > MAX_FILE_BYTES) continue;
      content = buf.toString("utf-8");
    } catch { continue; }

    processed++;
    const src = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    let fileCount = 0;

    for (const node of src.statements) {
      if (fileCount >= MAX_FUNCTIONS_PER_FILE) break;

      if (ts.isFunctionDeclaration(node) && node.name) {
        const isExp = !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export);
        if (!isExp) continue;
        const startLine = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;
        const endLine = src.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        const params = node.parameters.map(p =>
          `${p.name.getText(src)}${p.type ? ": " + p.type.getText(src) : ""}`
        );
        const returnType = node.type?.getText(src);
        results.push({ name: node.name.text, startLine, endLine, params, returnType, isExported: true, sourceFile: filePath });
        fileCount++;
        continue;
      }

      if (ts.isVariableStatement(node)) {
        const isExp = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
        if (!isExp) continue;
        for (const decl of node.declarationList.declarations) {
          if (fileCount >= MAX_FUNCTIONS_PER_FILE) break;
          if (!ts.isIdentifier(decl.name)) continue;
          const init = decl.initializer;
          if (!init || !ts.isArrowFunction(init)) continue;
          const startLine = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;
          const endLine = src.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
          const params = init.parameters.map(p =>
            `${p.name.getText(src)}${p.type ? ": " + p.type.getText(src) : ""}`
          );
          const returnType = init.type?.getText(src);
          results.push({ name: decl.name.text, startLine, endLine, params, returnType, isExported: true, sourceFile: filePath });
          fileCount++;
        }
      }
    }
  }

  return results;
}
