import { execSync } from "child_process";
import { getCommand, getAllSavedCommands, incrementSavedCommandRun, updateLastFailed } from "../indexer/db.js";
import { stripAnsi } from "./shell_cached.js";

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
      : "No commands saved yet — use bash(command, { save_as: 'name' }) to create one.";
    return `[augment-cc: no saved command "${args.name}". ${available}]`;
  }

  const cwd = args.cwd ?? process.cwd();
  const maxChars = args.max_output_chars ?? 8_000;

  let output: string;
  let failed = false;
  try {
    output = execSync(cmd.script, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (e: unknown) {
    failed = true;
    const err = e as { stdout?: string; stderr?: string; message?: string };
    output = err.stdout ?? err.stderr ?? err.message ?? String(e);
  }

  output = stripAnsi(output);

  const truncated = output.length > maxChars;
  const result = truncated
    ? output.slice(0, maxChars) + `\n[truncated: ${output.length} chars total]`
    : output;

  if (failed) {
    updateLastFailed(projectRoot, args.name);
    return `[script "${args.name}" failed — command was: ${cmd.script}\n\n${result}\n\nUpdate with bash(command, { save_as: "${args.name}" }) or use delete_command("${args.name}") to remove it.]`;
  }

  incrementSavedCommandRun(projectRoot, args.name);
  return result;
}
