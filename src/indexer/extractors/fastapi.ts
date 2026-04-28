import type { FastapiRoute } from "../types.js";

export function extractFastapi(content: string, sourceFile: string): FastapiRoute[] {
  const routes: FastapiRoute[] = [];

  // Collect all FastAPI app/router variable names
  const routerVars = new Set(["app", "router"]);
  const routerVarRe = /(\w+)\s*=\s*(?:APIRouter|FastAPI)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = routerVarRe.exec(content)) !== null) {
    routerVars.add(m[1]);
  }

  const varsPattern = [...routerVars].join("|");
  const routeRe = new RegExp(
    `@(?:${varsPattern})\\.(get|post|put|delete|patch|options|head)\\s*\\(\\s*['"]([^'"]+)['"]`,
    "gm"
  );

  while ((m = routeRe.exec(content)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], sourceFile });
  }

  return routes;
}
