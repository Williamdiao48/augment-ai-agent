import type { RailsRoute } from "../types.js";

const REST_ACTIONS: Record<string, { method: string; path: string; action: string }[]> = {
  index:   [{ method: "GET",    path: "",      action: "#index" }],
  show:    [{ method: "GET",    path: "/:id",  action: "#show" }],
  new:     [{ method: "GET",    path: "/new",  action: "#new" }],
  create:  [{ method: "POST",   path: "",      action: "#create" }],
  edit:    [{ method: "GET",    path: "/:id/edit", action: "#edit" }],
  update:  [{ method: "PUT",    path: "/:id",  action: "#update" }],
  destroy: [{ method: "DELETE", path: "/:id",  action: "#destroy" }],
};

const ALL_ACTIONS = Object.keys(REST_ACTIONS);

export function extractRails(content: string): RailsRoute[] {
  const routes: RailsRoute[] = [];
  const lines = content.split("\n");
  const prefixStack: string[] = [];
  const depthStack: number[] = [];
  let depth = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // Track do/end depth
    if (line.endsWith(" do") || line === "do") depth++;
    if (line === "end") {
      depth--;
      if (depthStack.length && depth <= depthStack[depthStack.length - 1]) {
        depthStack.pop();
        prefixStack.pop();
      }
      continue;
    }

    const prefix = prefixStack.join("");

    // Namespace/scope blocks
    const nsMatch = line.match(/^(?:namespace|scope)\s+:?['"]?(\w+)['"]?/);
    if (nsMatch) {
      prefixStack.push(`/${nsMatch[1]}`);
      depthStack.push(depth);
      continue;
    }

    // resources / resource
    const resourceMatch = line.match(/^(?:resources?)\s+:(\w+)(?:.*only:\s*\[([^\]]+)\])?/);
    if (resourceMatch) {
      const resource = resourceMatch[1];
      const onlyStr = resourceMatch[2];
      const actions = onlyStr
        ? onlyStr.split(",").map((s) => s.trim().replace(/[:'"]/g, ""))
        : ALL_ACTIONS;
      for (const action of actions) {
        for (const r of REST_ACTIONS[action] ?? []) {
          routes.push({
            method: r.method,
            path: `${prefix}/${resource}${r.path}`,
            action: `${resource}${r.action}`,
          });
        }
      }
      continue;
    }

    // Explicit routes: get '/path', to: 'controller#action'
    const explicitMatch = line.match(/^(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/i);
    if (explicitMatch) {
      const toMatch = line.match(/to:\s*['"]([^'"]+)['"]/);
      routes.push({
        method: explicitMatch[1].toUpperCase(),
        path: prefix + explicitMatch[2],
        action: toMatch ? toMatch[1] : "",
      });
    }
  }

  return routes;
}
