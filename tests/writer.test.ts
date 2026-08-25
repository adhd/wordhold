import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimWriterPath,
  recoverCurrentWriterIntent,
  withWriterSession,
  WriterBusyError,
} from "../core/writer.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "pt-writer-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Papertrail Test");
  git(root, "config", "user.email", "papertrail@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), "inbox/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "baseline");
  return root;
}

test("an interrupted writer keeps path ownership and recovers its own commit", async () => {
  const root = makeRepo();
  mkdirSync(join(root, "items"));
  await expect(
    withWriterSession(root, "daemon", async () => {
      claimWriterPath(root, "items/recovered.md");
      writeFileSync(join(root, "items", "recovered.md"), "complete canonical file\n");
      throw new Error("simulated death");
    }),
  ).rejects.toThrow("simulated death");

  await expect(
    withWriterSession(root, "enrichment", async () => {
      claimWriterPath(root, "items/recovered.md");
    }),
  ).rejects.toThrow("owned by another interrupted writer");

  await withWriterSession(root, "daemon", async () => {
    expect(
      await recoverCurrentWriterIntent("daemon: recover interrupted write"),
    ).toBe(true);
  });
  expect(git(root, "log", "-1", "--pretty=%s")).toBe(
    "daemon: recover interrupted write",
  );
  expect(git(root, "status", "--short")).toBe("");
});

test("an active writer excludes another process-sized session", async () => {
  const root = makeRepo();
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
  const releasePromise = new Promise<void>((resolve) => (release = resolve));
  const first = withWriterSession(root, "daemon", async () => {
    entered();
    await releasePromise;
  });
  await enteredPromise;
  await expect(
    withWriterSession(root, "enrichment", async () => {}, 10),
  ).rejects.toBeInstanceOf(WriterBusyError);
  release();
  await first;
});
