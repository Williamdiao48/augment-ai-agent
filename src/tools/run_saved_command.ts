import { execSync } from "child_process";
import { getCommand, getAllSavedCommands, incrementSavedCommandRun } from "../indexer/db.js";

export async function run_saved_command(args: {
  name: string;
  cwd?: string;
  max_output_chars?: number;
  _projectRoot?: string;
}): Promise<string> {
  const projectRoot = args._projectRoot ?? process.cwd();
  const cmd = getCommand(projectRoot, args.name);

  if (!cmd) {
    const all = getAllSavedCommands(projectRoot);
    const available = all.length > 0
      ? `Available commands: ${all.map(c => `"${c.name}"`).join(", ")}`
      : "No commands saved yet — use save_command(name, script, description) to create one.";
    return `[augment-cc: no saved command "${args.name}". ${available}]`;
  }

  const cwd = args.cwd ?? process.cwd();
  const maxChars = args.max_output_chars ?? 8_000;

  let output: string;
  try {
    output = execSync(cmd.script, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    output = err.stdout ?? err.stderr ?? err.message ?? String(e);
  }

  output = output.replace(/\x1b\[[0-9;]*[mGKHF]/g, "");

  const truncated = output.length > maxChars;
  const result = truncated
    ? output.slice(0, maxChars) + `\n[truncated: ${output.length} chars total]`
    : output;

  incrementSavedCommandRun(projectRoot, args.name);

  return result;
}
