import { isAbsolute } from "node:path";

interface GitResult {
  exitCode: number;
  stderr: string;
}

// Product-owned Git operations must target the explicit corpus root regardless
// of the shell, agent, or launch environment that started Wordhold. Git reads
// many GIT_* variables plus user/system config before considering cwd; clearing
// those inputs and disabling hooks keeps status/add/commit local and non-
// interactive while retaining the corpus repository's own identity config.
function gitEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_")) env[name] = value;
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

function gitCommand(args: string[]): string[] {
  return ["git", "-c", "core.hooksPath=/dev/null", ...args];
}

export function spawnGitSync(
  repoRoot: string | undefined,
  args: string[],
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(gitCommand(args), {
    ...(repoRoot ? { cwd: repoRoot } : {}),
    env: gitEnvironment(),
  });
}

async function gitOutput(repoRoot: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(gitCommand(args), {
    cwd: repoRoot,
    env: gitEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  return stdout;
}

async function git(repoRoot: string, args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(gitCommand(args), {
    cwd: repoRoot,
    env: gitEnvironment(),
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr };
}

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.split("/").some((part) => part === "..")
  );
}

export async function changedPaths(
  repoRoot: string,
  pathspecs: string[],
): Promise<string[]> {
  if (pathspecs.length === 0) return [];
  const output = await gitOutput(repoRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ...pathspecs,
  ]);
  const parts = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) paths.push(path);
    if (/[RC]/.test(status) && parts[i + 1]) {
      paths.push(parts[i + 1]);
      i += 1;
    }
  }
  return [...new Set(paths)].sort();
}

// Commits only the explicit runtime-owned paths. `git commit --only` prevents
// already-staged user/source work from leaking into a daemon or enrichment
// commit and leaves that unrelated index state untouched.
export async function commitPaths(
  repoRoot: string,
  paths: string[],
  message: string,
): Promise<boolean> {
  const unique = [...new Set(paths)].sort();
  if (unique.length === 0) return false;
  if (unique.some((path) => !safePath(path))) {
    throw new Error("refusing unsafe git path");
  }
  // A runtime batch can create and then merge away a new canonical path before
  // its first commit. It remains in the durable writer intent but is not a Git
  // deletion; filter through porcelain so a vanished untracked path cannot
  // make the real surviving mutations uncommittable.
  const changed = await changedPaths(repoRoot, unique);
  if (changed.length === 0) return false;

  const add = await git(repoRoot, ["add", "--", ...changed]);
  if (add.exitCode !== 0) {
    throw new Error(`git add failed: ${add.stderr.trim()}`);
  }
  const diff = await git(repoRoot, [
    "diff",
    "--cached",
    "--quiet",
    "--",
    ...changed,
  ]);
  if (diff.exitCode === 0) return false;
  if (diff.exitCode !== 1) {
    throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  }
  const commit = await git(repoRoot, [
    "commit",
    "--only",
    "--no-gpg-sign",
    "-m",
    message,
    "--",
    ...changed,
  ]);
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr.trim()}`);
  }
  return true;
}
