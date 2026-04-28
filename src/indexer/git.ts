import { execSync } from "child_process";

export interface GitState {
  branch: string;
  lastCommits: string[];
  modifiedFiles: string[];
}

export function getGitState(root: string): GitState | null {
  try {
    const branch = execSync("git branch --show-current", {
      cwd: root, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const log = execSync("git log --oneline -10", {
      cwd: root, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n").filter(Boolean);

    const status = execSync("git status --short", {
      cwd: root, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n").filter(Boolean);

    return { branch, lastCommits: log, modifiedFiles: status };
  } catch {
    return null;
  }
}

export function formatGitState(git: GitState | null): string {
  if (!git) return "";

  const lines: string[] = [`## Git State`, `Branch: **${git.branch}**`];

  if (git.modifiedFiles.length > 0) {
    lines.push(`Modified: ${git.modifiedFiles.slice(0, 10).join(", ")}`);
  }

  if (git.lastCommits.length > 0) {
    lines.push("", "Recent commits:");
    const shown = git.lastCommits.slice(0, 5);
    const rest = git.lastCommits.length - shown.length;
    shown.forEach((c) => lines.push(`- ${c}`));
    if (rest > 0) lines.push(`- [+${rest} more]`);
  }

  return lines.join("\n");
}
