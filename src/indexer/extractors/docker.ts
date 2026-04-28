import yaml from "js-yaml";
import type { DockerService } from "../types.js";

interface ComposeService {
  image?: string;
  build?: unknown;
  ports?: (string | number | { published?: number; target?: number })[];
  depends_on?: string[] | Record<string, unknown>;
}

interface ComposeDoc {
  services?: Record<string, ComposeService>;
}

export function extractDocker(content: string): DockerService[] {
  let doc: ComposeDoc;
  try {
    doc = yaml.load(content) as ComposeDoc;
  } catch {
    return [];
  }

  if (!doc?.services) return [];

  return Object.entries(doc.services).map(([name, svc]) => {
    const image = svc.image ?? (svc.build ? "<local build>" : "<unknown>");

    const ports = (svc.ports ?? []).map((p) => {
      if (typeof p === "string") return p;
      if (typeof p === "number") return String(p);
      return `${p.published ?? ""}:${p.target ?? ""}`;
    });

    const dependsOn = Array.isArray(svc.depends_on)
      ? svc.depends_on
      : Object.keys(svc.depends_on ?? {});

    return { name, image, ports, dependsOn };
  });
}
