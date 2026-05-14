import { execSync } from "child_process";
import { hashContent } from "../cache.js";
import { recordCommandRun, saveCommand } from "../indexer/db.js";
import { stripAnsi, stripPackageManagerNoise } from "./shell_cached.js";

export async function bash_exec(args: {
  command: string;
  filter?: boolean;
  max_output?: number;
  save_as?: string;
  description?: string;
  cwd?: string;
  _projectRoot?: string;
}): Promise<string> {
  const cwd = args.cwd ?? process.cwd();
  const maxChars = args.max_output ?? 8_000;
  const applyFilter = args.filter !== false;

  let output: string;
  try {
    output = execSync(args.command, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    output = err.stdout ?? err.stderr ?? err.message ?? String(e);
  }

  if (args._projectRoot) {
    try {
      recordCommandRun(args._projectRoot, hashContent(args.command).slice(0, 16), args.command);
    } catch { /* db may not be initialized */ }
  }

  if (applyFilter) {
    output = stripAnsi(output);
    output = stripPackageManagerNoise(args.command, output);
  }

  const truncated = output.length > maxChars;
  const result = truncated
    ? output.slice(0, maxChars) + `\n[truncated: ${output.length} chars total]`
    : output;

  if (args.save_as && args._projectRoot) {
    saveCommand(args._projectRoot, args.save_as, args.command, args.description ?? "");
  }

  return result;
}
