import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const defaultRoot = dirname(import.meta.dir);
export const CANONICAL_SOURCE_REMOTE = "https://github.com/adhd/wordhold.git";

function forbiddenPath(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? path;
  return ["items/", "inbox/", "logs/"].some(
    (prefix) => path.startsWith(prefix),
  ) || parts.includes(".scratch") || parts.includes(".wrangler") ||
    name === ".env" || name.startsWith(".env.") ||
    name === ".dev.vars" || name.startsWith(".dev.vars.") ||
    [
      "agent/tags.md",
      "docs/verification.md",
      "worker/wrangler.toml",
      "papertrail.config.json",
      "wordhold.config.json",
    ].includes(path) || /^(?:papertrail|wordhold)\.db(?:-|$)/.test(path);
}

function git(root: string, args: string[], allowFailure = false): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
  if (!allowFailure && output.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${output.stderr || output.stdout}`);
  }
  return output;
}

function lines(value: string): string[] {
  return value.split("\n").filter(Boolean);
}

function verifyRemoteBoundary(root: string): void {
  const remotes = lines(git(root, ["remote"]).stdout);
  if (remotes.length !== 1 || remotes[0] !== "origin") {
    throw new Error(
      `unexpected source remote: ${remotes.length ? remotes.join(", ") : "none"}`,
    );
  }
  const fetchUrls = lines(git(root, ["remote", "get-url", "--all", "origin"]).stdout);
  const pushUrls = lines(git(root, ["remote", "get-url", "--push", "--all", "origin"]).stdout);
  if (
    fetchUrls.length !== 1 ||
    pushUrls.length !== 1 ||
    fetchUrls[0] !== CANONICAL_SOURCE_REMOTE ||
    pushUrls[0] !== CANONICAL_SOURCE_REMOTE
  ) {
    throw new Error("source origin is not the canonical origin URL");
  }
}

function verifyRefBoundary(root: string): void {
  const allowed = [
    /^refs\/heads\/main$/,
    /^refs\/remotes\/origin\/(?:HEAD|main)$/,
    /^refs\/tags\/v\d+\.\d+\.\d+(?:-rc\.\d+)?$/,
  ];
  const unexpected = lines(
    git(root, ["for-each-ref", "--format=%(refname)"]).stdout,
  ).filter((ref) => !allowed.some((pattern) => pattern.test(ref)));
  if (unexpected.length) {
    throw new Error(`unexpected source ref: ${unexpected.join(", ")}`);
  }
}

export function verifySourceBoundary(options: {
  allowDirty?: boolean;
  forbiddenObject?: string;
  requireCanonicalReleaseContext?: boolean;
  root?: string;
} = {}): { revision: string; trackedFiles: number; reachableObjects: number } {
  const root = realpathSync(options.root ?? defaultRoot);
  if (git(root, ["rev-parse", "--is-shallow-repository"]).stdout !== "false") {
    throw new Error("canonical source history must not be shallow");
  }
  const commonGitDirectory = resolve(
    root,
    git(root, ["rev-parse", "--git-common-dir"]).stdout,
  );
  if (existsSync(join(commonGitDirectory, "info", "grafts"))) {
    throw new Error("canonical source history must not use legacy grafts");
  }
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout;
  if (!options.allowDirty && status) {
    throw new Error("canonical source worktree is dirty");
  }
  // Privacy checks must work in forks and CI, where remotes and branch refs are
  // legitimately different. Only release production binds those Git details
  // to the canonical repository; both modes still scan every reachable object.
  if (options.requireCanonicalReleaseContext) {
    verifyRemoteBoundary(root);
    verifyRefBoundary(root);
  }
  if (git(root, ["for-each-ref", "--format=%(refname)", "refs/replace"]).stdout) {
    throw new Error("canonical source has replacement refs");
  }
  const alternates = join(root, ".git", "objects", "info", "alternates");
  if (existsSync(alternates)) throw new Error("canonical source has object alternates");
  git(root, ["fsck", "--full", "--strict"]);

  const tracked = lines(git(root, ["ls-files"]).stdout);
  const forbiddenTracked = tracked.filter(forbiddenPath);
  if (forbiddenTracked.length) {
    throw new Error(`private path is tracked: ${forbiddenTracked.join(", ")}`);
  }
  // `HEAD` may be detached in public pull-request CI. Include it explicitly so
  // deleted private bytes in that candidate's ancestry cannot evade a scan
  // merely because the checkout did not create a local branch ref.
  const objects = lines(git(root, ["rev-list", "--objects", "--all", "HEAD"]).stdout);
  const forbiddenHistory = objects
    .map((line) => line.split(" ").slice(1).join(" "))
    .filter((path) => path && forbiddenPath(path));
  if (forbiddenHistory.length) {
    throw new Error(`private path is reachable in history: ${forbiddenHistory.join(", ")}`);
  }

  const unsafeContent = [
    /\/Users\/(?!(?:example|test)\b)[A-Za-z0-9._-]+/,
    /https:\/\/(?!w\.example\.workers\.dev\b)[a-z0-9.-]+\.workers\.dev/i,
    /(?:account_id|database_id)\s*=\s*"(?:[0-9a-f]{32}|[0-9a-f-]{36})"/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /(?:CLOUDFLARE_API_(?:TOKEN|KEY)|CF_API_TOKEN)\s*=\s*["']?[^\s"']{12,}/i,
    /(?:PAPERTRAIL|WORDHOLD)_(?:CAPTURE_)?SECRET\s*=\s*[^\s"']{12,}/,
    /(?:^|[\r\n])\s*(?:SECRET|CAPTURE_SECRET)\s*=\s*["']?[^\s"'#]{12,}/,
  ];
  const assertSafe = (
    bytes: Uint8Array,
    label: string,
  ): void => {
    const text = Buffer.from(bytes).toString("utf8");
    for (const pattern of unsafeContent) {
      if (pattern.test(text)) throw new Error(`private content marker in ${label}`);
    }
  };
  for (const path of tracked) {
    if (
      path === "scripts/verify-source-boundary.ts" ||
      !existsSync(join(root, path)) ||
      !lstatSync(join(root, path)).isFile()
    ) continue;
    assertSafe(readFileSync(join(root, path)), path);
  }
  // Scan every reachable historical blob as well as the current worktree. A
  // private value cannot be made acceptable merely by deleting it later.
  for (const object of objects) {
    const [id, ...pathParts] = object.split(" ");
    if (!id || git(root, ["cat-file", "-t", id]).stdout !== "blob") continue;
    const result = Bun.spawnSync(["git", "cat-file", "blob", id], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(`could not inspect source object ${id}`);
    assertSafe(result.stdout, `history:${pathParts.join(" ") || id}`);
  }

  const forbiddenObjects = new Set(
    options.forbiddenObject ? [options.forbiddenObject] : [],
  );
  for (const object of forbiddenObjects) {
    const found = git(root,
      ["cat-file", "-e", `${object}^{commit}`],
      true,
    ).exitCode === 0;
    if (found) throw new Error("forbidden predecessor object is reachable");
  }
  return {
    revision: git(root, ["rev-parse", "HEAD"]).stdout,
    trackedFiles: tracked.length,
    reachableObjects: objects.length,
  };
}

if (import.meta.main) {
  const objectIndex = process.argv.indexOf("--forbidden-object");
  const result = verifySourceBoundary({
    allowDirty: process.argv.includes("--allow-dirty"),
    forbiddenObject: objectIndex === -1 ? undefined : process.argv[objectIndex + 1],
  });
  console.log(JSON.stringify({ status: "clean-source", ...result }));
}
