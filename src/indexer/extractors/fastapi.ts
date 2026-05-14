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

  // First pass: collect include_router prefix mounts
  // e.g. app.include_router(user_router, prefix="/api/v1/users")
  const prefixMap = new Map<string, string>(); // routerVar → prefix
  const includeRe = /include_router\(\s*(\w+)[^)]*prefix\s*=\s*['"]([^'"]+)['"]/g;
  while ((m = includeRe.exec(content)) !== null) {
    prefixMap.set(m[1], m[2]);
  }

  // Second pass: extract routes, capturing the var name for prefix resolution
  const varsPattern = [...routerVars].join("|");
  const routeRe = new RegExp(
    `@(${varsPattern})\\.(get|post|put|delete|patch|options|head)\\s*\\(\\s*['"]([^'"]+)['"]`,
    "gm"
  );

  while ((m = routeRe.exec(content)) !== null) {
    const varName = m[1];
    const method = m[2].toUpperCase();
    const rawPath = m[3];
    const prefix = prefixMap.get(varName) ?? "";
    const path = prefix ? `${prefix}${rawPath}` : rawPath;
    routes.push({ method, path, sourceFile });
  }

  return routes;
}
