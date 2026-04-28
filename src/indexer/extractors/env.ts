import type { EnvKey } from "../types.js";

const SECRET_RE = /^(<[^>]+>|your_|changeme|xxx|secret|password|key|token)/i;

export function extractEnv(content: string): EnvKey[] {
  const keys: EnvKey[] = [];

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;

    const name = match[1];
    const value = match[2].trim();
    const isEmpty = value === "";
    const isSecret = isEmpty || SECRET_RE.test(value);

    keys.push({
      name,
      defaultValue: isSecret ? null : value,
      isSecret,
    });
  }

  return keys;
}
