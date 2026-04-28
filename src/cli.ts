import { resolve } from "path";
import { initIndexDb, getStoredIndex } from "./indexer/db.js";
import { getGitState, formatGitState } from "./indexer/git.js";
import { rebuildProjectIndex } from "./indexer/index.js";
import type { ProjectIndex } from "./indexer/types.js";

const STALE_MS = Number(process.env.AUGMENT_CC_STALE_MS ?? 3_600_000);

function parseProjectRoot(argv: string[]): string {
  const idx = argv.indexOf("--project-root");
  return idx !== -1 && argv[idx + 1] ? resolve(argv[idx + 1]) : process.cwd();
}

async function runInject(root: string): Promise<void> {
  initIndexDb();

  let stored = getStoredIndex(root);

  if (stored && Date.now() - stored.built_at > STALE_MS) {
    process.stderr.write("augment-cc: index stale, refreshing...\n");
    await rebuildProjectIndex(root);
    stored = getStoredIndex(root);
  }

  const gitBlock = formatGitState(getGitState(root));

  if (!stored) {
    const parts = [gitBlock, `<!-- augment-cc: no index for ${root} — run: augment-cc refresh -->`].filter(Boolean);
    process.stdout.write(parts.join("\n\n") + "\n");
    return;
  }

  const index: ProjectIndex = JSON.parse(stored.index_json);
  const modelCount = index.db.prismaModels.length + index.db.sqlTables.length
    + index.db.djangoModels.length + index.db.typeormModels.length;
  const routeCount = index.routes.express.length + index.routes.nextjs.length
    + index.routes.fastapi.length + index.routes.rails.length;
  const typeCount = index.types.tsInterfaces.length + index.types.graphqlTypes.length;
  const hasMeaningful = modelCount + routeCount + typeCount + index.docker.length > 0;

  const qualityNote = hasMeaningful
    ? null
    : `<!-- augment-cc: index is file-tree only (detected: ${index.detectedTypes.join(", ") || "none"}) — project may use unrecognized frameworks. Don't over-trust this index. -->`;

  const parts = [gitBlock, qualityNote, stored.index_md].filter(Boolean);
  process.stdout.write(parts.join("\n\n") + "\n");
}

async function runRefresh(root: string): Promise<void> {
  process.stderr.write(`augment-cc: rebuilding index for ${root}...\n`);
  await rebuildProjectIndex(root);
  process.stderr.write("augment-cc: done.\n");
}

export async function runCli(argv: string[]): Promise<void> {
  const command = argv[2];
  const root = parseProjectRoot(argv);
  if (command === "inject") return runInject(root);
  if (command === "refresh") return runRefresh(root);
  process.stderr.write(`augment-cc: unknown command "${command}"\nUsage: augment-cc inject|refresh [--project-root <path>]\n`);
  process.exit(1);
}
