import { watch } from "chokidar";
import { relative } from "path";
import type { Ignore } from "ignore";

type ChangeHandler = (filePath: string) => void;
type DeleteHandler = (filePath: string) => void;

function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: T) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function startWatcher(
  root: string,
  ig: Ignore,
  onChange: ChangeHandler,
  onDelete: DeleteHandler,
): void {
  const debouncedChange = debounce(onChange, 500);

  watch(root, {
    ignored: (filePath: string) => {
      const rel = relative(root, filePath);
      return rel !== "" && ig.ignores(rel);
    },
    ignoreInitial: true,
    persistent: true,
    depth: 10,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  })
    .on("change", debouncedChange)
    .on("add", debouncedChange)
    .on("unlink", onDelete);
}
