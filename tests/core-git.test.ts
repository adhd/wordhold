import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, commitPaths } from "../core/git.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

test("commitPaths commits only its writer paths and leaves unrelated work staged", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-git-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Papertrail Test");
  git(root, "config", "user.email", "papertrail@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, "items"));
  writeFileSync(join(root, "items", "one.md"), "before\n");
  writeFileSync(join(root, "unrelated.ts"), "before\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "baseline");

  writeFileSync(join(root, "items", "one.md"), "after\n");
  writeFileSync(join(root, "unrelated.ts"), "unrelated change\n");
  git(root, "add", "unrelated.ts");

  expect(await changedPaths(root, ["items"])).toEqual(["items/one.md"]);

  expect(
    await commitPaths(root, ["items/one.md"], "daemon: drain 1 capture"),
  ).toBe(true);
  expect(git(root, "show", "--pretty=format:", "--name-only", "HEAD")).toBe(
    "items/one.md",
  );
  expect(git(root, "diff", "--cached", "--name-only")).toBe("unrelated.ts");
  expect(git(root, "show", "HEAD:items/one.md")).toBe("after");
});

test("commitPaths is a no-op when its paths have no changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-git-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Papertrail Test");
  git(root, "config", "user.email", "papertrail@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-qm", "baseline");

  expect(await commitPaths(root, ["base.txt"], "daemon: no changes")).toBe(
    false,
  );
});

test("commitPaths ignores a claimed untracked path created and removed within the batch", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-git-transient-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Papertrail Test");
  git(root, "config", "user.email", "papertrail@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, "items"));
  writeFileSync(join(root, "items", "winner.md"), "before\n");
  git(root, "add", "items/winner.md");
  git(root, "commit", "-qm", "baseline");

  writeFileSync(join(root, "items", "winner.md"), "after merge\n");
  const transient = join(root, "items", "never-committed-loser.md");
  writeFileSync(transient, "temporary loser\n");
  unlinkSync(transient);

  expect(await commitPaths(
    root,
    ["items/winner.md", "items/never-committed-loser.md"],
    "daemon: merge captures",
  )).toBe(true);
  expect(git(root, "show", "HEAD:items/winner.md")).toBe("after merge");
});
