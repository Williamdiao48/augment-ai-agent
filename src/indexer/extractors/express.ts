import type { ExpressRoute } from "../types.js";

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

export function extractExpress(content: string, sourceFile: string): ExpressRoute[] {
  const routes: ExpressRoute[] = [];
  const cleaned = stripComments(content);

  // Collect all router/app variable names
  const routerVars = new Set(["app", "router"]);
  const routerVarRe = /(\w+)\s*=\s*(?:express\.Router|Router)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = routerVarRe.exec(cleaned)) !== null) {
    routerVars.add(m[1]);
  }

  // First pass: collect prefix mounts — app.use('/prefix', routerVar)
  // Cross-file mounting (router defined elsewhere) is not resolved here.
  const prefixMap = new Map<string, string>(); // routerVar → prefix
  const mountRe = /(\w+)\.use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\w+)/g;
  while ((m = mountRe.exec(cleaned)) !== null) {
    const subRouter = m[3];
    const prefix = m[2];
    if (routerVars.has(subRouter)) {
      prefixMap.set(subRouter, prefix);
    }
  }

  // Second pass: extract routes, capturing the var name for prefix resolution
  // Excludes `use` — those are middleware/mounts, not routes
  const varsPattern = [...routerVars].join("|");
  const routeRe = new RegExp(
    `(${varsPattern})\\.(get|post|put|delete|patch|all)\\s*\\(\\s*(['"\`])([^'"\`]+)\\3`,
    "gm"
  );

  while ((m = routeRe.exec(cleaned)) !== null) {
    const varName = m[1];
    const method = m[2].toUpperCase();
    const rawPath = m[4];
    const prefix = prefixMap.get(varName) ?? "";
    const path = prefix ? `${prefix}${rawPath}` : rawPath;
    routes.push({ method, path, sourceFile });
  }

  return routes;
}
