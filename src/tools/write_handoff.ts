import { saveHandoff } from "../indexer/db.js";

export async function write_handoff(args: {
  content: string;
  _projectRoot?: string;
}): Promise<string> {
  const root = args._projectRoot ?? process.cwd();
  saveHandoff(root, args.content);
  return `[augment-cc: handoff saved — will be injected at the start of the next session]`;
}
