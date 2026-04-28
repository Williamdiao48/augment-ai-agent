import { readFile } from "fs/promises";
import { join } from "path";
import { fileExists } from "./walker.js";
import type { ProjectType } from "./types.js";

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function fileContains(path: string, text: string): Promise<boolean> {
  try {
    const content = await readFile(path, "utf-8");
    return content.includes(text);
  } catch {
    return false;
  }
}

function hasDep(pkg: Record<string, unknown>, name: string): boolean {
  const deps = (pkg.dependencies ?? {}) as Record<string, unknown>;
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, unknown>;
  return name in deps || name in devDeps;
}

function hasAnyDep(pkg: Record<string, unknown>, names: string[]): boolean {
  return names.some((n) => hasDep(pkg, n));
}

export async function detectProjectTypes(root: string, allFiles: string[]): Promise<Set<ProjectType>> {
  const types = new Set<ProjectType>();

  const pkg = await readJson(join(root, "package.json"));

  const hasFile = (name: string) => fileExists(join(root, name));
  const anyFile = (names: string[]) => Promise.any(names.map(hasFile)).catch(() => false);
  const fileSetHas = (suffix: string) => allFiles.some((f) => f.endsWith(suffix));
  const fileSetHasDir = (dir: string) => allFiles.some((f) => f.includes(`/${dir}/`) || f.endsWith(`/${dir}`));

  // Prisma
  if (allFiles.some((f) => f.endsWith("schema.prisma"))) types.add("prisma");

  // SQL migrations
  if (allFiles.some((f) => /\/(migrations?|migrate)\/.+\.sql$/.test(f))) types.add("sql-migrations");

  // Django
  if (allFiles.some((f) => f.endsWith("models.py"))) {
    types.add("django");
    types.add("python");
  }

  // Python (general)
  if (fileSetHas(".py")) types.add("python");

  // Ruby
  if (fileSetHas(".rb")) types.add("ruby");

  // Rails
  if (await hasFile("config/routes.rb")) types.add("rails");

  // Next.js
  if (await anyFile(["next.config.js", "next.config.ts", "next.config.mjs"])) {
    types.add("nextjs");
  } else if (fileSetHasDir("app") || fileSetHasDir("pages")) {
    if (pkg && hasDep(pkg, "next")) types.add("nextjs");
  }

  // TypeScript
  if (fileSetHas(".ts") || fileSetHas(".tsx")) types.add("typescript");

  // Express
  if (types.has("typescript") && pkg && hasDep(pkg, "express")) types.add("express");

  // TypeORM / Sequelize
  if (types.has("typescript") && pkg && hasAnyDep(pkg, ["typeorm", "sequelize", "sequelize-typescript"])) {
    types.add("typeorm");
  }

  // FastAPI
  if (types.has("python")) {
    const hasFastapi =
      (await fileContains(join(root, "requirements.txt"), "fastapi")) ||
      (await fileContains(join(root, "pyproject.toml"), "fastapi"));
    if (hasFastapi) types.add("fastapi");
  }

  // GraphQL
  if (allFiles.some((f) => f.endsWith(".graphql") || f.endsWith(".gql"))) types.add("graphql");

  // Docker
  if (await anyFile(["docker-compose.yml", "docker-compose.yaml"])) types.add("docker");

  // Env
  if (await anyFile([".env.example", ".env.sample", ".env.template"])) types.add("env");

  return types;
}
