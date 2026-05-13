<!-- Project context auto-injected by augment-cc. Run `npm run build` first. -->
!node dist/index.js inject --project-root $PWD

<!-- augment-cc:rules:start -->
## augment-cc Tool Rules
- **Use `cache_read`** for all information-gathering file reads. Deduplicates re-reads — unchanged files return a ~15-token stub instead of re-injecting full content.
- **Before Edit or Write:** use native Read with `offset` + `limit` scoped to just the lines you are changing. Do not use native Read for information gathering.
- **Use `shell_cached`** for all read-only shell commands (git log, git status, find, ls).
- **Use `run_saved_command(name)`** for any project script you have previously saved. Check the Script Library section of the project index at session start.
- **After compaction:** if `cache_read` returns a stub for content you no longer have, call with `force: true` to recover it. If you lose project schema/routes/types, read the `project://index` MCP resource.
<!-- augment-cc:rules:end -->
