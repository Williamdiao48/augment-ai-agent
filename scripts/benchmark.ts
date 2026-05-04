import { performance } from "perf_hooks";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { cache_read } from "../src/tools/cache_read.js";
import { shell_cached } from "../src/tools/shell_cached.js";
import { stats, invalidate } from "../src/cache.js";
import { initIndexDb } from "../src/indexer/db.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

initIndexDb();

// Generate a large fixture file simulating a real schema/types file (~500 lines, ~60K chars).
// This gives Scenarios 2 and 3 a realistic large file to work against.
const FIXTURE_PATH = join(tmpdir(), "augment-cc-bench-fixture.ts");
const fixtureLines: string[] = [
  `// augment-cc benchmark fixture — ${new Date().toISOString()}`,
  `// Simulates a large TypeScript schema/types file in a real project.`,
  ``,
];
for (let i = 0; i < 99; i++) {
  fixtureLines.push(
    `export interface ApiModel${i} { id: string; userId: number; tenantId: string; name: string; email: string; ` +
    `role: "admin"|"user"|"viewer"|"guest"; status: "active"|"inactive"|"pending"|"suspended"; ` +
    `createdAt: Date; updatedAt: Date; deletedAt: Date | null; metadata: Record<string,unknown>; tags: string[]; }`
  );
  fixtureLines.push(`export type ApiModel${i}Input = Omit<ApiModel${i}, "id" | "createdAt" | "updatedAt" | "deletedAt">;`);
  fixtureLines.push(`export type ApiModel${i}Patch = Partial<ApiModel${i}Input> & { updatedAt?: Date };`);
  fixtureLines.push(
    `export const ApiModel${i}Config = { tableName: "api_model_${i}s", primaryKey: "id", schemaName: "public", ` +
    `softDelete: true, timestamps: ["createdAt","updatedAt","deletedAt"], indices: ["userId","tenantId","email"] } as const;`
  );
  fixtureLines.push(``);
}
writeFileSync(FIXTURE_PATH, fixtureLines.join("\n"));

function newSid(): string {
  return `bench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function timed(fn: () => Promise<string>): Promise<{ out: string; ms: number }> {
  const t0 = performance.now();
  const out = await fn();
  return { out, ms: Math.round(performance.now() - t0) };
}

const fmt = (n: number) => n.toLocaleString("en-US");

function row(label: string, ms: number, chars: number, tag = ""): void {
  const msStr = ms === 0 ? "  <1" : String(ms).padStart(4);
  process.stdout.write(
    `  ${label.padEnd(40)} ${msStr} ms   ${fmt(chars).padStart(8)} chars` +
    (tag ? `   ${tag}` : "") + "\n"
  );
}

function speedupStr(coldMs: number, warmMs: number): string {
  if (warmMs === 0) return `>${coldMs}×`;
  return `${(coldMs / warmMs).toFixed(0)}×`;
}

const LINE = "═".repeat(64);
const line = "─".repeat(64);

let charsAvoided = 0;
let watchdogCount = 0;

// ─────────────────────────────────────────────────────────────
console.log(`\naugment-cc benchmark — ${ROOT}`);
console.log(LINE + "\n");

// ══ Scenario 1: Content-hash file cache ══════════════════════
console.log("Scenario 1  File Read Caching (content-hash cache)");
console.log(line);

const file1 = "src/index.ts";
invalidate(`file:${resolve(ROOT, file1)}`);

const s1cold = await timed(() =>
  cache_read({ path: file1, project_root: ROOT, _sessionId: newSid() })
);
const s1warm = await timed(() =>
  cache_read({ path: file1, project_root: ROOT, _sessionId: newSid() })
);

// Strip "[cached] " prefix (9 chars) for char comparison — content is identical
const s1warmContent = s1warm.out.startsWith("[cached] ") ? s1warm.out.slice(9) : s1warm.out;

row(`cold read    ${file1}`, s1cold.ms, s1cold.out.length, "cache miss — disk read + hash");
row(`warm read    ${file1}`, s1warm.ms, s1warmContent.length, "cache hit  — hash match, no reprocessing");
console.log(`  note: content cache ensures stable output across sessions; primary token savings come from dedup (scenario 2)\n`);

// ══ Scenario 2: Session dedup + watchdog ═════════════════════
console.log("Scenario 2  Session Deduplication + Compaction Watchdog");
console.log(line);

const sid2 = newSid();
invalidate(`file:${FIXTURE_PATH}`);

const r2a = await timed(() => cache_read({ path: FIXTURE_PATH, _sessionId: sid2 }));
const r2b = await timed(() => cache_read({ path: FIXTURE_PATH, _sessionId: sid2 }));
const r2c = await timed(() => cache_read({ path: FIXTURE_PATH, _sessionId: sid2 }));

const isStub = r2b.out.includes("already read this session");
const isWdog = r2c.out.includes("compaction watchdog");
if (isWdog) watchdogCount++;

row(`read 1  fixture (${fixtureLines.length} lines)`, r2a.ms, r2a.out.length, "full content");
row(`read 2  fixture (same session)`,                 r2b.ms, r2b.out.length, isStub ? "dedup stub ← context saved" : "unexpected");
row(`read 3  fixture (same session)`,                 r2c.ms, r2c.out.length, isWdog ? "watchdog REFRESH ← compaction guard" : "unexpected");

const dedupSaved = Math.max(0, r2a.out.length - r2b.out.length);
charsAvoided += dedupSaved;
console.log(`  chars avoided by dedup stub: ${fmt(dedupSaved)}\n`);

// ══ Scenario 3: Keyword excerpt ══════════════════════════════
console.log("Scenario 3  Keyword Excerpt Search");
console.log(line);

// Use the large fixture with "ApiModel50" — appears in exactly 3 lines (one model's
// interface + input type + patch type), so keyword returns a tight excerpt vs the full file.
const r3full = await timed(() =>
  cache_read({ path: FIXTURE_PATH, _sessionId: newSid() })
);
const r3kw = await timed(() =>
  cache_read({ path: FIXTURE_PATH, _sessionId: newSid(), keyword: "ApiModel50", context_lines: 2 })
);

const kwReduction = Math.round((1 - r3kw.out.length / r3full.out.length) * 100);
const kwSaved = Math.max(0, r3full.out.length - r3kw.out.length);
charsAvoided += kwSaved;

row(`full read    fixture (${fixtureLines.length} lines)`,  r3full.ms, r3full.out.length, "all lines returned");
row(`keyword "ApiModel50"  fixture`,                         r3kw.ms,  r3kw.out.length,  `1 match region — ${kwReduction}% smaller`);
console.log(`  chars avoided by targeted search: ${fmt(kwSaved)}\n`);

// ══ Scenario 4: Shell command caching ════════════════════════
console.log("Scenario 4  Shell Command Caching (TTL cache)");
console.log(line);

for (const { cmd, ttl } of [
  { cmd: "git status",            ttl: "10s TTL" },
  { cmd: "git log --oneline -10", ttl: "30s TTL" },
]) {
  invalidate(`shell:${ROOT}:${cmd}`);

  const fresh  = await timed(() => shell_cached({ command: cmd, cwd: ROOT }));
  const cached = await timed(() => shell_cached({ command: cmd, cwd: ROOT }));

  row(`${cmd} (fresh)`,  fresh.ms,  fresh.out.length,  ttl);
  row(`${cmd} (cached)`, cached.ms, cached.out.length, `cache hit — ${speedupStr(fresh.ms, cached.ms)} faster`);
  console.log();
}

// ══ Scenario 5: Output filter chain ══════════════════════════
console.log("Scenario 5  Output Filter Chain (patch hunk stripping)");
console.log(line);

const patchCmd = "git log --patch --oneline -1";
invalidate(`shell:${ROOT}:${patchCmd}`);

const rawPatch    = execSync(patchCmd, { cwd: ROOT, encoding: "utf-8" });
const s5filtered  = await timed(() =>
  shell_cached({ command: patchCmd, cwd: ROOT, max_output_chars: 100_000 })
);

const filterPct   = Math.round((1 - s5filtered.out.length / rawPatch.length) * 100);
const filterSaved = Math.max(0, rawPatch.length - s5filtered.out.length);
charsAvoided += filterSaved;

row("git log --patch (raw)",      0,         rawPatch.length,      "diff hunks present");
row("git log --patch (filtered)", s5filtered.ms, s5filtered.out.length, `${filterPct}% smaller — hunks stripped`);
console.log(`  chars avoided by filter chain: ${fmt(filterSaved)}\n`);

// cleanup
unlinkSync(FIXTURE_PATH);

// ══ Summary ══════════════════════════════════════════════════
console.log(LINE);
console.log("Summary");

const s = stats();
console.log(`  Total chars avoided:    ~${fmt(charsAvoided)}`);
console.log(`  Estimated tokens saved: ~${fmt(Math.round(charsAvoided / 4))}  (4 chars/token)`);
console.log(`  Watchdog triggers:      ${watchdogCount}`);
console.log(`  Cache entries:          ${s.total} total, ${s.expired} expired`);
console.log();
