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

  const varsPattern = [...routerVars].join("|");
  const routeRe = new RegExp(
    `(?:${varsPattern})\\.(get|post|put|delete|patch|all|use)\\s*\\(\\s*(['"\`])([^'"\`]+)\\2`,
    "gm"
  );

  while ((m = routeRe.exec(cleaned)) !== null) {
    routes.push({
      method: m[1].toUpperCase(),
      path: m[3],
      sourceFile,
    });
  }

  return routes;
}
