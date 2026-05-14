import { readFile } from "fs/promises";
import { join, extname, basename } from "path";
import { hashContent } from "../cache.js";
import { initIndexDb, getStoredIndex, saveIndex, getFileHash, saveFileHash, deleteFileEntry } from "./db.js";
import { buildIgnore, walkProject, buildFileTree } from "./walker.js";
import { detectProjectTypes } from "./detector.js";
import { startWatcher } from "./watcher.js";
import { formatIndex } from "./formatter.js";
import { extractPrisma } from "./extractors/prisma.js";
import { extractSql } from "./extractors/sql.js";
import { extractDjango } from "./extractors/django.js";
import { extractTypeorm } from "./extractors/typeorm.js";
import { extractExpress } from "./extractors/express.js";
import { extractNextjs } from "./extractors/nextjs.js";
import { extractFastapi } from "./extractors/fastapi.js";
import { extractRails } from "./extractors/rails.js";
import { extractTypescript, extractTsFunctions, isHighValueTypeFile } from "./extractors/typescript.js";
import { extractGraphql } from "./extractors/graphql.js";
import { extractEnv } from "./extractors/env.js";
import { extractDocker } from "./extractors/docker.js";
import { extractPython } from "./extractors/python.js";
import type { ProjectIndex, DatabaseSchema, RouteList, TypeSchema } from "./types.js";
import type { Ignore } from "ignore";

function emptyIndex(root: string): ProjectIndex {
  return {
    projectRoot: root,
    detectedTypes: [],
    db: { prismaModels: [], prismaEnums: [], sqlTables: [], djangoModels: [], typeormModels: [] },
    routes: { express: [], nextjs: [], fastapi: [], rails: [] },
    types: { tsInterfaces: [], graphqlTypes: [], tsFunctions: [] },
    env: [],
    docker: [],
    fileTree: { totalFiles: 0, byExtension: {}, topDirs: [] },
    python: [],
    declarations: [],
    builtAt: Date.now(),
  };
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

export class IndexerService {
  private root: string;
  private ig: Ignore | null = null;
  private currentIndex: ProjectIndex;

  constructor(root: string) {
    this.root = root;
    this.currentIndex = emptyIndex(root);
  }

  async init(): Promise<void> {
    initIndexDb();
    this.ig = await buildIgnore(this.root);
  }

  async start(): Promise<void> {
    await this.init();
    await this.buildFullIndex();
    startWatcher(
      this.root,
      this.ig!,
      (f) => void this.handleFileChange(f),
      (f) => void this.handleFileDelete(f),
    );
  }

  async buildFullIndex(): Promise<void> {
    const allFiles = await walkProject(this.root, this.ig!);
    const detectedTypes = await detectProjectTypes(this.root, allFiles);
    const index = emptyIndex(this.root);
    index.detectedTypes = [...detectedTypes];
    index.fileTree = buildFileTree(allFiles, this.root);

    const db: DatabaseSchema = index.db;
    const routes: RouteList = index.routes;
    const types: TypeSchema = index.types;

    const tsTypeFiles: string[] = [];
    const tsFunctionFiles: string[] = [];

    for (const filePath of allFiles) {
      const content = await safeRead(filePath);
      if (content === null) continue;

      const hash = hashContent(content);
      const ext = extname(filePath);
      const name = basename(filePath);

      // Prisma
      if (detectedTypes.has("prisma") && name === "schema.prisma") {
        try {
          const result = extractPrisma(content);
          db.prismaModels.push(...result.models);
          db.prismaEnums.push(...result.enums);
          saveFileHash(this.root, filePath, hash, "prisma");
        } catch (e) { process.stderr.write(`augment-cc [prisma] ${e}\n`); }
      }

      // SQL
      if (detectedTypes.has("sql-migrations") && ext === ".sql" && /\/(migrations?|migrate)\//.test(filePath)) {
        try {
          db.sqlTables.push(...extractSql(content, filePath));
          saveFileHash(this.root, filePath, hash, "sql");
        } catch (e) { process.stderr.write(`augment-cc [sql] ${e}\n`); }
      }

      // Django
      if (detectedTypes.has("django") && name === "models.py") {
        try {
          db.djangoModels.push(...extractDjango(content));
          saveFileHash(this.root, filePath, hash, "django");
        } catch (e) { process.stderr.write(`augment-cc [django] ${e}\n`); }
      }

      // TypeORM
      if (detectedTypes.has("typeorm") && (ext === ".ts" || ext === ".js") && content.includes("@Entity")) {
        try {
          db.typeormModels.push(...extractTypeorm(content, filePath));
          saveFileHash(this.root, filePath, hash, "typeorm");
        } catch (e) { process.stderr.write(`augment-cc [typeorm] ${e}\n`); }
      }

      // Express
      if (detectedTypes.has("express") && (ext === ".ts" || ext === ".js") && content.includes("express")) {
        try {
          routes.express.push(...extractExpress(content, filePath));
          saveFileHash(this.root, filePath, hash, "express");
        } catch (e) { process.stderr.write(`augment-cc [express] ${e}\n`); }
      }

      // FastAPI
      if (detectedTypes.has("fastapi") && ext === ".py" && content.includes("fastapi")) {
        try {
          routes.fastapi.push(...extractFastapi(content, filePath));
          saveFileHash(this.root, filePath, hash, "fastapi");
        } catch (e) { process.stderr.write(`augment-cc [fastapi] ${e}\n`); }
      }

      // Rails
      if (detectedTypes.has("rails") && filePath.endsWith("config/routes.rb")) {
        try {
          routes.rails.push(...extractRails(content));
          saveFileHash(this.root, filePath, hash, "rails");
        } catch (e) { process.stderr.write(`augment-cc [rails] ${e}\n`); }
      }

      // GraphQL
      if (detectedTypes.has("graphql") && (ext === ".graphql" || ext === ".gql")) {
        try {
          types.graphqlTypes.push(...extractGraphql(content));
          saveFileHash(this.root, filePath, hash, "graphql");
        } catch (e) { process.stderr.write(`augment-cc [graphql] ${e}\n`); }
      }

      // Env
      if (detectedTypes.has("env") && /\/(\.env\.example|\.env\.sample|\.env\.template)$/.test(filePath)) {
        try {
          index.env.push(...extractEnv(content));
          saveFileHash(this.root, filePath, hash, "env");
        } catch (e) { process.stderr.write(`augment-cc [env] ${e}\n`); }
      }

      // Docker
      if (detectedTypes.has("docker") && /docker-compose\.ya?ml$/.test(filePath)) {
        try {
          index.docker.push(...extractDocker(content));
          saveFileHash(this.root, filePath, hash, "docker");
        } catch (e) { process.stderr.write(`augment-cc [docker] ${e}\n`); }
      }

      // TypeScript types — collect candidates, process after
      if (detectedTypes.has("typescript") && (ext === ".ts" || ext === ".tsx") && isHighValueTypeFile(filePath)) {
        tsTypeFiles.push(filePath);
      }

      // TypeScript function refs — all TS files
      if (detectedTypes.has("typescript") && (ext === ".ts" || ext === ".tsx")) {
        tsFunctionFiles.push(filePath);
      }

      // Python class/function extraction (all .py files)
      if (detectedTypes.has("python") && ext === ".py") {
        try {
          index.python.push(...extractPython(content, filePath));
          saveFileHash(this.root, filePath, hash, "python");
        } catch (e) { process.stderr.write(`augment-cc [python] ${e}\n`); }
      }

    }

    // Next.js — directory-based, not file-by-file
    if (detectedTypes.has("nextjs")) {
      try {
        routes.nextjs.push(...(await extractNextjs(this.root)));
      } catch (e) { process.stderr.write(`augment-cc [nextjs] ${e}\n`); }
    }

    // TypeScript interfaces — batched AST pass (high-value type files only)
    if (tsTypeFiles.length > 0) {
      try {
        types.tsInterfaces.push(...(await extractTypescript(tsTypeFiles)));
      } catch (e) { process.stderr.write(`augment-cc [typescript] ${e}\n`); }
    }

    // TypeScript function refs — all TS files
    if (tsFunctionFiles.length > 0) {
      try {
        types.tsFunctions.push(...(await extractTsFunctions(tsFunctionFiles)));
      } catch (e) { process.stderr.write(`augment-cc [ts-functions] ${e}\n`); }
    }

    index.builtAt = Date.now();
    this.currentIndex = index;
    const json = JSON.stringify(index);
    const md = formatIndex(index);
    saveIndex(this.root, json, md, allFiles.length);
  }

  private async handleFileChange(filePath: string): Promise<void> {
    const content = await safeRead(filePath);
    if (content === null) return;

    const hash = hashContent(content);
    const storedHash = getFileHash(this.root, filePath);
    if (storedHash === hash) return; // unchanged

    // Rebuild full index on any relevant file change — simple and correct
    // Incremental per-extractor merging is a future optimization
    try {
      await this.buildFullIndex();
    } catch (e) {
      process.stderr.write(`augment-cc [watcher] rebuild error: ${e}\n`);
    }
  }

  private async handleFileDelete(filePath: string): Promise<void> {
    deleteFileEntry(this.root, filePath);
    try {
      await this.buildFullIndex();
    } catch (e) {
      process.stderr.write(`augment-cc [watcher] rebuild error: ${e}\n`);
    }
  }
}

export async function getProjectIndex(root: string): Promise<string | null> {
  const stored = getStoredIndex(root);
  return stored?.index_md ?? null;
}

export async function rebuildProjectIndex(root: string): Promise<void> {
  const svc = new IndexerService(root);
  await svc.init();
  await svc.buildFullIndex();
}
