# augment-cc

An MCP server that augments Claude Code with tool caching, session-level deduplication, and persistent project context — so long sessions stay coherent longer and repeat work is avoided.

Built for heavy Claude Code usage where context compaction is a real constraint.

---

## What it does

| Feature | Problem solved |
|---|---|
| **File read cache** | Same file read twice in one session re-injects the full content — burning context |
| **mtime fast-path** | Warm cache hits skip `readFileSync` entirely — stat-only check on unchanged files |
| **Session dedup** | After compaction, Claude reaches for files it already read — dedup returns a stub instead |
| **Diff-based re-read** | If a file is re-read in a session and the content changed, return a unified diff instead of the full file |
| **Shell output filters** | `git log --patch` dumps thousands of diff lines — strip hunks, keep commit metadata |
| **Dense keyword handling** | Search terms that appear on every line collapse into a giant blob — sampled mode shows 10 evenly-spaced regions instead |
| **Project index** | Every session starts cold on project structure — inject a structural snapshot at session start |
| **Polyglot indexer** | JS/TS projects got deep extraction; Python, Go, Rust, Java, etc. got file-tree only — now all languages get symbol-level extraction |
| **Session memory** | Prior sessions are summarized and injected on next start — Claude knows what changed last time |
| **Decision extraction** | Session summaries capture *why* decisions were made, not just *what* changed — injected as "Key decisions" on next start |
| **Tool enforcement** | Claude reverts to native Read after compaction — a PreToolUse hook redirects it to `cache_read` at the call site, surviving compaction |
| **Codebase audit** | Claude writes duplicate utilities and bloated files when it can't see existing code health — audit injects project-specific warnings before each session |

---

## Benchmark

Run against this repository (`npm run benchmark`):

```
Scenario 1  File Read Caching (content-hash cache)
  cold read    src/index.ts                       1 ms      3,896 chars   cache miss — disk read + hash
  warm read    src/index.ts                      <1 ms      3,896 chars   cache hit  — hash match, no reprocessing
  note: content cache ensures stable output across sessions; primary token savings come from dedup (scenario 2)

Scenario 2  Session Deduplication + Diff-based Change Detection
  read 1  fixture (498 lines)                     2 ms     69,655 chars   full content
  read 2  fixture (same session)                  1 ms        119 chars   dedup stub ← unchanged
  read 3  fixture (same session)                  1 ms        119 chars   dedup stub ← unchanged
  chars avoided by dedup stub: 69,536
  note: re-reads return a stub when file is unchanged; a diff is shown when the file was modified

Scenario 3  Keyword Excerpt Search
  full read    fixture (498 lines)                1 ms     69,664 chars   all lines returned
  keyword "ApiModel50"  fixture                   1 ms      1,369 chars   1 match region — 98% smaller
  chars avoided by targeted search: 68,295

Scenario 4  Shell Command Caching (TTL cache)
  git status (fresh)                             21 ms        418 chars   10s TTL
  git status (cached)                            <1 ms        427 chars   cache hit — >21× faster

  git log --oneline -10 (fresh)                  20 ms        783 chars   30s TTL
  git log --oneline -10 (cached)                 <1 ms        792 chars   cache hit — >20× faster

Scenario 5  Output Filter Chain (patch hunk stripping)
  git log --patch (raw)                          <1 ms      7,663 chars   diff hunks present
  git log --patch (filtered)                     16 ms      3,779 chars   51% smaller — hunks stripped
  chars avoided by filter chain: 3,884

Scenario 6  mtime Fast-Path (skip readFileSync on warm reads)
  cold read    src/cache.ts                       1 ms      2,385 chars   cache miss — stat + read + hash + store
  warm read    src/cache.ts                      <1 ms      2,394 chars   mtime hit — stat only, no readFileSync
  note: mtime fast-path avoids readFileSync on unchanged files — benefits large files most

Scenario 7  Dense Keyword Search (sampled mode)
  keyword "export"  fixture (dense)               1 ms     10,381 chars   sampled mode — 85% smaller
  keyword "ApiModel50"  fixture (sparse)          <1 ms      1,369 chars   normal mode — 98% smaller
  chars avoided by targeted sparse search: 68,286

════════════════════════════════════════════════════════════════
Summary
  Total chars avoided:    ~208,400
  Estimated tokens saved: ~52,100  (4 chars/token)
  Cache entries:          18 total, 8 expired
```

The headline numbers: dedup saves 99.8% of re-read chars (69K → 119 byte stub), keyword search finds a specific type in 1,369 chars vs 69K full read (98% reduction), dense keyword search on a ubiquitous term still yields 85% reduction via sampled mode, and patch hunk stripping cuts `git log` output by 54%. When a file is modified mid-session, augment-cc returns a unified diff instead of the full file — only the delta enters context. Total estimated token savings: ~52K tokens per benchmark run.

---

## Setup

### 1. Install globally (one-time)

```bash
git clone <this-repo>
cd augment-cc
npm install && npm run build && npm link
```

`npm link` registers `augment-cc` as a global command pointing at the local build. After this step you never touch the clone again.

> **Permission error on `npm link`?** Your global node install may be owned by root. Either `sudo npm link`, or configure a user-level npm prefix (recommended — no sudo ever again):
> ```bash
> mkdir -p ~/.npm-global
> npm config set prefix '~/.npm-global'
> echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
> npm link
> ```

### 2. Initialize in any project (one command)

```bash
cd /your-project
augment-cc init
```

This does four things automatically:

**`.mcp.json`** — registers augment-cc as an MCP server for Claude Code:
```json
{
  "mcpServers": {
    "augment-cc": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/augment-cc/dist/index.js"]
    }
  }
}
```

**`CLAUDE.md`** — adds an inject hook that fires at session start, loading the project index and recent session summaries:
```
!node /path/to/augment-cc/dist/index.js inject --project-root $PWD
```

**`~/.claude/settings.json`** — adds a Stop hook that summarizes each session when you close Claude Code:
```json
{
  "hooks": {
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/augment-cc/dist/index.js summarize" }] }]
  }
}
```

**`.claude/settings.local.json`** — adds a PreToolUse hook that intercepts native `Read` calls and redirects Claude to `cache_read` instead. This enforces tool usage at the call site rather than relying on in-context instructions, so it keeps working even after context compaction:
```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Read", "hooks": [{ "type": "command", "command": "node /path/to/augment-cc/dist/index.js redirect-read" }] }]
  }
}
```

Then it builds the initial project index.

### 3. Restart Claude Code

The MCP server connects on startup. Restart Claude Code (or the extension host) once after init.

### 4. Verify

```bash
augment-cc status
```

All four hooks should show `✓`. If any show `✗`, re-run `augment-cc init`.

---

## What Claude sees at session start

When a session opens, the `CLAUDE.md` inject hook fires and prints a context block that includes:

- **Git state** — current branch, last 5 commits, modified files
- **Tool preferences** — instruction to use `cache_read` and `shell_cached` instead of native tools
- **High-value files** — files read most frequently across prior sessions (signals which files matter)
- **Recent session summaries** — what was worked on in the last 3 sessions, what files changed, what branch
- **Key decisions** — architectural decisions extracted from prior session transcripts ("instead of X we chose Y because...")
- **Project index** — DB schema, API routes, TypeScript types, env vars, Docker services, polyglot symbol index, file tree

This means even a fresh session starts with full project context rather than cold.

---

## For large / long sessions

augment-cc is specifically designed for sessions that hit compaction. When compaction occurs, Claude loses earlier context and starts re-reading files it already processed. augment-cc intercepts those re-reads:

- **Re-read, file unchanged** → returns a short stub (`~120 chars`) instead of re-injecting the full file. The stub confirms the file is unchanged so Claude knows its cached knowledge is still valid.
- **Re-read, file was modified** → returns a unified diff of what changed since the last read. Only the delta enters context — not the full file again.

To get this benefit on an existing project you're already working in:

```bash
# From your project directory
augment-cc init

# Restart Claude Code, then continue your session as normal
# augment-cc will handle dedup and diffs transparently
```

---

## Commands

```
augment-cc <command> [--project-root <path>]

  init       Set up augment-cc in the current project (writes hooks + builds index + runs audit)
  upgrade    Re-apply latest hook config without rebuilding the index (run after git pull)
  audit      Scan for oversized files, duplicate function names, and high-export dumping-ground files
  inject     Print context injection block (used by CLAUDE.md hook)
  refresh    Force-rebuild the project index
  summarize  Parse session transcript and save summary (used by Stop hook)
  status     Show cache stats, session history, and hook configuration
```

```bash
# Re-apply hook config after pulling updates (fast, no index rebuild)
augment-cc upgrade

# Run the codebase audit on demand (e.g. after a big refactor)
augment-cc audit

# Force a fresh index build (e.g. after adding new files)
augment-cc refresh

# Check what's been recorded
augment-cc status

# Run the benchmark (from the augment-cc repo)
npm run benchmark
```

---

## MCP Tools

Once the MCP server is connected, Claude has access to:

### `cache_read`

Read a file with content-hash caching and session-level deduplication.

```
path          — file to read (absolute or relative)
max_lines     — truncate to N lines (default: 500)
project_root  — base for resolving relative paths
keyword       — return only lines matching this term + surrounding context
context_lines — lines of context around each keyword match (default: 10)
```

When `keyword` is set, the tool automatically detects dense matches (term appears on >20% of lines after merging) and switches to sampled mode — returning 10 evenly-spaced representative regions rather than one giant merged block.

Claude should prefer this over the native `Read` tool for all file reads during a session.

### `shell_cached`

Run a read-only shell command with TTL-based caching.

```
command          — shell command to run
cwd              — working directory (default: process.cwd())
ttl_ms           — cache TTL override (auto-detected by command pattern)
max_output_chars — truncate output to N chars (default: 8000)
```

TTL presets: `git status` → 10s, `git log` → 30s, `find` → 60s, package manager list → 5min.

Claude should prefer this over raw shell calls for git log, git status, find, ls.

### `project://index` (resource)

Structural index of the project: DB schema, API routes, TypeScript types, env vars, Docker services, polyglot symbol index, file tree, and live git state. Rebuilt incrementally via file watcher while the server runs.

---

## Configuration

All via environment variables (set in `.mcp.json` `env` block or shell):

| Variable | Default | Description |
|---|---|---|
| `AUGMENT_CC_STALE_MS` | `3600000` (1h) | Age at which the project index is considered stale |
| `AUGMENT_CC_MAX_SESSIONS` | `10` | Sessions to retain per project |
| `AUGMENT_CC_INJECT_MAX_CHARS` | _(unlimited)_ | Cap total inject block size; trims the project index first, preserving git state and session summaries |
| `AUGMENT_CC_COMPACTION_AGE_MS` | `900000` (15 min) | Age threshold before MCP sampling is used to check if file content is still in context |
| `AUGMENT_CC_AUDIT_OVERSIZED_LINES` | `300` | Line count threshold for oversized file warning in audit |
| `AUGMENT_CC_AUDIT_HIGH_EXPORTS` | `15` | Export count threshold for dumping-ground file warning in audit |
| `AUGMENT_CC_MAX_MODELS` | `20` | Max DB models shown in inject block and project index (raise for projects with large schemas) |

To cap inject output for projects with very large indexes (e.g. many env vars):
```json
"env": { "AUGMENT_CC_INJECT_MAX_CHARS": "8000" }
```

---

## Codebase audit

`augment-cc audit` (and `augment-cc init`) scans the project for three structural health signals and stores the results in SQLite. At the start of every session, the inject block includes a `## Code Health Warnings` section if any violations exist — giving Claude project-specific context before it writes anything. Clean codebases get no section.

**Three warning classes:**

| Warning | What it signals | Default threshold |
|---|---|---|
| Oversized files | File is too long to reason about as a unit — consider splitting | >300 lines |
| Duplicate symbol names | Same function/type name exported from multiple files — likely redundancy | 2+ files |
| High-export files | One file exports too many symbols — likely a utility dumping ground | >15 exports |

The oversized check only applies to real source files (`.ts`, `.py`, `.go`, `.rs`, etc.) — generated files like `package-lock.json` are excluded. TypeScript function declarations are detected via regex (`export function`, `export const x = (`) since the TS indexer only captures interfaces and types.

Run on demand after a large refactor:
```bash
augment-cc audit
```

---

## How the project index works

On startup (and after file changes via watcher), augment-cc walks the project and extracts:

- **Database schemas** — Prisma models, raw SQL tables, Django models, TypeORM entities
- **API routes** — Express, Next.js, FastAPI, Rails
- **TypeScript types** — interfaces, type aliases, GraphQL types
- **Python symbols** — top-level classes with method signatures, module-level functions (all `.py` files)
- **Polyglot declarations** — Go, Rust, Java, Kotlin, C#, Swift, Ruby, Elixir, and others via a universal declaration-keyword regex
- **Infrastructure** — Docker services, environment variables (placeholder values filtered out, capped at 20)
- **File tree** — depth-limited tree of source files

The index is stored in SQLite and served via the `project://index` MCP resource. It's injected at session start via the CLAUDE.md hook so Claude has full project context before it reads a single file.
