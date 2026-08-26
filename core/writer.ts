// Cross-process canonical-writer coordination. The lock prevents daemon and
// enrichment overlap; per-owner intents make claimed paths recoverable after
// a process death and distinguish runtime-owned dirt from human edits.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { atomicWriteFile } from "./atomic.ts";
import { commitPaths, spawnGitSync } from "./git.ts";
import { ensurePrivateDir } from "./private-fs.ts";

export type WriterOwner = "daemon" | "enrichment" | "resurface";

interface IntentFile {
  owner: WriterOwner;
  paths: string[];
}

interface WriterContext {
  repoRoot: string;
  owner: WriterOwner;
  paths: Set<string>;
  otherClaims: Set<string>;
}

const storage = new AsyncLocalStorage<WriterContext>();

export class WriterBusyError extends Error {
  constructor() {
    super("another Wordhold archive writer is running");
    this.name = "WriterBusyError";
  }
}

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.split("/").some((part) => part === "..")
  );
}

function intentPath(repoRoot: string, owner: WriterOwner): string {
  return join(repoRoot, "inbox", "writer-intents", `${owner}.json`);
}

function readIntent(repoRoot: string, owner: WriterOwner): Set<string> {
  const path = intentPath(repoRoot, owner);
  if (!existsSync(path)) return new Set();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as IntentFile;
  if (parsed.owner !== owner || !Array.isArray(parsed.paths)) {
    throw new Error(`invalid writer intent for ${owner}`);
  }
  const paths = parsed.paths.filter(
    (value): value is string => typeof value === "string" && safePath(value),
  );
  if (paths.length !== parsed.paths.length) {
    throw new Error(`unsafe path in writer intent for ${owner}`);
  }
  return new Set(paths);
}

function allOtherClaims(
  repoRoot: string,
  owner: WriterOwner,
): Set<string> {
  const claims = new Set<string>();
  for (const candidate of ["daemon", "enrichment", "resurface"] as const) {
    if (candidate === owner) continue;
    for (const path of readIntent(repoRoot, candidate)) claims.add(path);
  }
  return claims;
}

function pathDirty(repoRoot: string, path: string): boolean {
  const result = spawnGitSync(repoRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    path,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`git status failed while claiming ${path}`);
  }
  return new TextDecoder().decode(result.stdout).trim().length > 0;
}

function persistContext(ctx: WriterContext): void {
  atomicWriteFile(
    intentPath(ctx.repoRoot, ctx.owner),
    JSON.stringify({ owner: ctx.owner, paths: [...ctx.paths].sort() }) + "\n",
  );
}

export function claimWriterPath(repoRoot: string, path: string): void {
  const ctx = storage.getStore();
  if (!ctx) return; // direct library/test use outside a runtime writer
  if (ctx.repoRoot !== repoRoot) throw new Error("writer context repo mismatch");
  if (!safePath(path)) throw new Error(`unsafe writer path ${path}`);
  if (ctx.paths.has(path)) return;
  if (ctx.otherClaims.has(path)) {
    throw new Error(`${path} is owned by another interrupted writer`);
  }
  if (pathDirty(repoRoot, path)) {
    throw new Error(`refusing pre-existing dirty path ${path}`);
  }
  ctx.paths.add(path);
  persistContext(ctx); // intent is durable before the canonical mutation
}

export function currentWriterPaths(): string[] {
  return [...(storage.getStore()?.paths ?? [])].sort();
}

export function clearCurrentWriterIntent(): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  const path = intentPath(ctx.repoRoot, ctx.owner);
  if (existsSync(path)) unlinkSync(path);
  ctx.paths.clear();
}

export async function recoverCurrentWriterIntent(
  message: string,
): Promise<boolean> {
  const ctx = storage.getStore();
  if (!ctx) throw new Error("writer recovery requires an active session");
  const paths = [...ctx.paths].sort();
  if (!paths.length) return false;
  const committed = await commitPaths(ctx.repoRoot, paths, message);
  clearCurrentWriterIntent();
  return committed;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireLock(
  repoRoot: string,
  timeoutMs: number,
): Promise<{ dir: string; token: string }> {
  const inbox = join(repoRoot, "inbox");
  ensurePrivateDir(inbox);
  const dir = join(inbox, "writer.lock");
  const token = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(
        join(dir, "owner.json"),
        JSON.stringify({ pid: process.pid, token }) + "\n",
        { mode: 0o600 },
      );
      return { dir, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = JSON.parse(
          readFileSync(join(dir, "owner.json"), "utf8"),
        ) as { pid?: unknown };
        stale = typeof owner.pid !== "number" || !pidAlive(owner.pid);
      } catch {
        // mkdir is the atomic lock acquisition; give its owner time to write
        // metadata instead of deleting a live lock during that tiny gap.
        try {
          stale = Date.now() - statSync(dir).mtimeMs > 30_000;
        } catch {
          continue; // lock disappeared between checks; retry acquisition
        }
      }
      if (stale) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new WriterBusyError();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function releaseLock(lock: { dir: string; token: string }): void {
  try {
    const owner = JSON.parse(
      readFileSync(join(lock.dir, "owner.json"), "utf8"),
    ) as { token?: unknown };
    if (owner.token === lock.token) {
      rmSync(lock.dir, { recursive: true, force: true });
    }
  } catch {
    // A stale-lock recovery may already have removed it.
  }
}

export async function withWriterSession<T>(
  repoRoot: string,
  owner: WriterOwner,
  fn: () => Promise<T>,
  timeoutMs = 1_000,
): Promise<T> {
  const lock = await acquireLock(repoRoot, timeoutMs);
  const ctx: WriterContext = {
    repoRoot,
    owner,
    paths: readIntent(repoRoot, owner),
    otherClaims: allOtherClaims(repoRoot, owner),
  };
  try {
    return await storage.run(ctx, fn);
  } finally {
    releaseLock(lock);
  }
}
