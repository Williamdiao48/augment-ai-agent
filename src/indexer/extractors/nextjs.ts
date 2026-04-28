import { readdir, readFile } from "fs/promises";
import { join, relative } from "path";
import type { NextjsRoute } from "../types.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

function pathToRoute(relPath: string, stripPrefix: string): string {
  let route = relPath
    .replace(new RegExp(`^${stripPrefix}/`), "/")
    .replace(/\\/g, "/");

  // Remove route groups: (groupName)/
  route = route.replace(/\/\([^)]+\)/g, "");

  // Replace catch-all [[...param]] -> :param*
  route = route.replace(/\[\[\.\.\.(\w+)\]\]/g, ":$1*");

  // Replace dynamic [param] -> :param
  route = route.replace(/\[(\w+)\]/g, ":$1");

  // Remove trailing /page or /route
  route = route.replace(/\/(page|route)\.(tsx?|jsx?|js)$/, "");

  // Remove file extension from pages router
  route = route.replace(/\.(tsx?|jsx?|js)$/, "");

  return route || "/";
}

async function extractAppRouter(appDir: string): Promise<NextjsRoute[]> {
  const routes: NextjsRoute[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const rel = relative(appDir, abs);
        if (/^page\.(tsx?|jsx?)$/.test(entry.name)) {
          routes.push({ method: "GET", path: pathToRoute(rel, ""), routerType: "app" });
        } else if (/^route\.(tsx?|jsx?)$/.test(entry.name)) {
          try {
            const content = await readFile(abs, "utf-8");
            for (const method of HTTP_METHODS) {
              if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(content)) {
                routes.push({ method, path: pathToRoute(rel, ""), routerType: "app" });
              }
            }
          } catch {
            routes.push({ method: "ALL", path: pathToRoute(rel, ""), routerType: "app" });
          }
        }
      }
    }
  }

  await walk(appDir);
  return routes;
}

async function extractPagesRouter(pagesDir: string): Promise<NextjsRoute[]> {
  const routes: NextjsRoute[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && !entry.name.startsWith("_")) {
        const rel = relative(pagesDir, abs);
        routes.push({ method: "ALL", path: "/api/" + pathToRoute(rel, "").replace(/^\//, ""), routerType: "pages" });
      }
    }
  }

  await walk(pagesDir);
  return routes;
}

export async function extractNextjs(root: string): Promise<NextjsRoute[]> {
  const routes: NextjsRoute[] = [];

  try {
    routes.push(...(await extractAppRouter(join(root, "app"))));
  } catch { /* no app dir */ }

  try {
    routes.push(...(await extractPagesRouter(join(root, "pages", "api"))));
  } catch { /* no pages/api dir */ }

  return routes;
}
