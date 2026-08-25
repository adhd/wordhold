import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DATA_IGNORE } from "../core/installation.ts";

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

test("ordinary staging excludes private runtime evidence but keeps canonical journals", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-ignore-"));
  try {
    writeFileSync(join(root, ".gitignore"), DATA_IGNORE);
    writeFileSync(join(root, "README.md"), "fixture\n");
    mkdirSync(join(root, "logs", "bad-captures"), { recursive: true });
    const runtime = [
      ".env",
      ".env.local",
      ".dev.vars",
      ".scratch/issue.md",
      "papertrail.config.json",
      "papertrail.db",
      "papertrail.db-wal",
      "inbox/raw/capture.json",
      "inbox/merges/merge.json",
      "inbox/writer-intents/daemon.json",
      "logs/bad-captures/bad.json",
      "logs/bad-worker-captures.jsonl",
      "logs/bad-worker-captures-seen.txt",
      "logs/quarantine.jsonl",
      "logs/quarantine-seen.txt",
      "logs/oversized-worker-bodies.jsonl",
      "logs/oversized-worker-bodies-seen.txt",
      "logs/outbox.log",
    ];
    for (const path of runtime) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), "private\n");
    }
    writeFileSync(join(root, "logs", "new-tags.jsonl"), "{}\n");
    writeFileSync(join(root, "logs", "resurfacing.jsonl"), "{}\n");

    git(root, "init", "-q");
    expect(git(root, "check-ignore", "--", ...runtime).split("\n")).toEqual(
      runtime,
    );
    const ordinaryStatus = git(root, "status", "--short", "--untracked-files=all");
    for (const path of runtime) expect(ordinaryStatus).not.toContain(path);
    git(root, "add", "-A");
    const tracked = git(root, "ls-files").split("\n").filter(Boolean);
    expect(tracked).toContain("logs/new-tags.jsonl");
    expect(tracked).toContain("logs/resurfacing.jsonl");
    for (const path of runtime) expect(tracked).not.toContain(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
