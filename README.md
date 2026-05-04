# augment-cc

An MCP server that augments Claude Code with tool caching, session-level deduplication, and persistent project context — so long sessions stay coherent longer and repeat work is avoided.

Built for heavy Claude Code usage where context compaction is a real constraint.

---

## What it does

Four things, each solving a specific failure mode in long sessions:

| Feature | Problem solved |
|---|---|
| **File read cache** | Same file read twice in one session re-injects the full content — burning context |
| **Session dedup** | After compaction, Claude reaches for files it already read — dedup returns a stub instead |
| **Compaction watchdog** | If a file is re-read 3× in a session, the context was probably compacted — refresh it automatically |
| **Shell output filters** | `git log --patch` dumps thousands of diff lines — strip hunks, keep commit metadata |
| **Project index** | Every session starts cold on project structure — inject a structural snapshot at session start |
| **Session memory** | Prior sessions are summarized and injected on next start — Claude knows what changed last time |

---

## Benchmark

Run against this repository (`npm run benchmark`):

```
Scenario 1  File Read Caching (content-hash cache)
  cold read    src/index.ts                       1 ms      3,896 chars   cache miss — disk read + hash
  warm read    src/index.ts                      <1 ms      3,896 chars   cache hit  — hash match, no reprocessing
  note: content cache ensures stable output across sessions; primary token savings come from dedup (scenario 2)

Scenario 2  Session Deduplication + Compaction Watchdog
  read 1  fixture (498 lines)                     2 ms     69,655 chars   full content
  read 2  fixture (same session)                  1 ms        149 chars   dedup stub ← context saved
  read 3  fixture (same session)                  1 ms     69,800 chars   watchdog REFRESH ← compaction guard
  chars avoided by dedup stub: 69,506

Scenario 3  Keyword Excerpt Search
  full read    fixture (498 lines)                1 ms     69,664 chars   all lines returned
  keyword "ApiModel50"  fixture                   1 ms      1,369 chars   1 match region — 98% smaller
  chars avoided by targeted search: 68,295

Scenario 4  Shell Command Caching (TTL cache)
  git status (fresh)                             28 ms        423 chars   10s TTL
  git status (cached)                            <1 ms        432 chars   cache hit — >28× faster

  git log --oneline -10 (fresh)                  21 ms        661 chars   30s TTL
  git log --oneline -10 (cached)                 <1 ms        670 chars   cache hit — >21× faster

Scenario 5  Output Filter Chain (patch hunk stripping)
  git log --patch (raw)                          <1 ms     10,449 chars   diff hunks present
  git log --patch (filtered)                     18 ms      1,055 chars   90% smaller — hunks stripped
  chars avoided by filter chain: 9,394

════════════════════════════════════════════════════════════════
Summary
  Total chars avoided:    ~147,195
  Estimated tokens saved: ~36,799  (4 chars/token)
  Watchdog triggers:      1
  Cache entries:          7 total, 0 expired
```

The headline numbers: dedup saves 99.8% of re-read chars (69K → 149 byte stub), keyword search finds a specific type definition in 1,369 chars instead of reading 69K chars (98% reduction), and patch hunk stripping cuts git log output by 90%.

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

This does three things automatically:

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

Then it builds the initial project index.

### 3. Restart Claude Code

The MCP server connects on startup. Restart Claude Code (or the extension host) once after init.

### 4. Verify

```bash
augment-cc status
```

All three hooks should show `✓`. If any show `✗`, re-run `augment-cc init`.

---

## What Claude sees at session start

When a session opens, the `CLAUDE.md` inject hook fires and prints a context block that includes:

- **Git state** — current branch, last 5 commits, modified files
- **Tool preferences** — instruction to use `cache_read` and `shell_cached` instead of native tools
- **High-value files** — files read most frequently across prior sessions (signals which files matter)
- **Recent session summaries** — what was worked on in the last 3 sessions, what files changed, what branch
- **Project index** — DB schema, API routes, TypeScript types, env vars, Docker services, file tree

This means even a fresh session starts with full project context rather than cold.

---

## For large / long sessions

augment-cc is specifically designed for sessions that hit compaction. When compaction occurs, Claude loses earlier context and starts re-reading files it already processed. augment-cc intercepts those re-reads:

- **First re-read after compaction** → returns a short stub (`~130 chars`) instead of re-injecting the full file. Saves the context that re-injection would cost.
- **Third re-read of the same file** → compaction has probably happened twice. The watchdog fires and returns a full refresh with a warning header, so Claude gets back what it lost.

To get this benefit on an existing project you're already working in:

```bash
# From your project directory
augment-cc init

# Restart Claude Code, then continue your session as normal
# augment-cc will handle dedup and watchdog transparently
```

---

## Commands

```
augment-cc <command> [--project-root <path>]

  init       Set up augment-cc in the current project (writes .mcp.json, CLAUDE.md, Stop hook)
  inject     Print context injection block (used by CLAUDE.md hook)
  refresh    Force-rebuild the project index
  summarize  Parse session transcript and save summary (used by Stop hook)
  status     Show cache stats, session history, and hook configuration
```

```bash
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

Structural index of the project: DB schema, API routes, TypeScript types, env vars, Docker services, file tree, and live git state. Rebuilt incrementally via file watcher while the server runs.

---

## Configuration

All via environment variables (set in `.mcp.json` `env` block or shell):

| Variable | Default | Description |
|---|---|---|
| `AUGMENT_CC_WATCHDOG_THRESHOLD` | `3` | Re-reads before watchdog triggers a full refresh |
| `AUGMENT_CC_STALE_MS` | `3600000` (1h) | Age at which the project index is considered stale |
| `AUGMENT_CC_MAX_SESSIONS` | `10` | Sessions to retain per project |

To lower the watchdog threshold for very long sessions (more aggressive refresh), edit the `env` block in your project's `.mcp.json`:
```json
"env": { "AUGMENT_CC_WATCHDOG_THRESHOLD": "2" }
```

---

## How the project index works

On startup (and after file changes via watcher), augment-cc walks the project and extracts:

- **Database schemas** — Prisma models, raw SQL tables, Django models, TypeORM entities
- **API routes** — Express, Next.js, FastAPI, Rails
- **TypeScript types** — interfaces, type aliases, GraphQL types
- **Infrastructure** — Docker services, environment variables
- **File tree** — depth-limited tree of source files

The index is stored in SQLite and served via the `project://index` MCP resource. It's injected at session start via the CLAUDE.md hook so Claude has full project context before it reads a single file.
