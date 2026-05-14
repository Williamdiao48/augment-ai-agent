import { getAllSavedCommands, getTopCommandRuns } from "../indexer/db.js";

function formatAge(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export async function list_commands(args: { _projectRoot?: string }): Promise<string> {
  const root = args._projectRoot ?? process.cwd();
  const saved = getAllSavedCommands(root);
  const frequent = getTopCommandRuns(root, 5, saved.map(s => s.script));

  const lines: string[] = [];

  if (saved.length === 0 && frequent.length === 0) {
    return "[augment-cc: no saved commands yet — use bash(command, { save_as: 'name' }) to save one]";
  }

  if (saved.length > 0) {
    lines.push("## Script Library");
    for (const s of saved) {
      const failNote = s.last_failed_at
        ? ` [last failed: ${formatAge(s.last_failed_at)}]`
        : "";
      lines.push(`- \`${s.name}\` (${s.run_count} runs) — ${s.description || s.script}${failNote}`);
    }
  }

  if (frequent.length > 0) {
    lines.push("", "## Frequently Run (unsaved)");
    for (const f of frequent) {
      const preview = f.command.length > 70 ? f.command.slice(0, 70) + "…" : f.command;
      lines.push(`- \`${preview}\` (${f.run_count}×)`);
    }
  }

  return lines.join("\n");
}
