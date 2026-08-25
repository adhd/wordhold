import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDistribution,
  verifyDistributionArtifact,
} from "../scripts/build-distribution.ts";

const archive = process.env.PAPERTRAIL_V01_ARCHIVE;
const retainedUpgrade = archive ? test : test.skip;
const expectedDigest =
  "d4e24a228a67de6b3494ce9c2f3bb056528f51952f7022b0b36c381c7be590f1";

function run(
  args: string[],
  env: Record<string, string> = {},
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(args, { env: { ...process.env, ...env } });
}

function ok(args: string[], env: Record<string, string> = {}): string {
  const result = run(args, env);
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout);
}

function okJson(
  args: string[],
  payload: Record<string, unknown>,
  env: Record<string, string>,
): string {
  const result = Bun.spawnSync(args, {
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout);
}

function git(root: string, ...args: string[]): string {
  return ok(["git", ...args], {
    GIT_DIR: join(root, ".git"),
    GIT_WORK_TREE: root,
  }).trim();
}

retainedUpgrade("the exact retained v0.1 release upgrades without changing private authority", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pt-real-v01-upgrade-"));
  try {
    const bytes = readFileSync(archive!);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedDigest);
    const suppliedCandidate = process.env.WORDHOLD_RELEASE_ARTIFACT;
    const candidate = suppliedCandidate
      ? realpathSync(suppliedCandidate)
      : join(scratch, "New Release With Spaces");
    const installRoot = join(scratch, "Recipient Home", "app");
    const dataRoot = join(scratch, "Recipient Home", "data");
    const recipientEnv = {
      HOME: join(scratch, "Recipient Home"),
      TMPDIR: scratch,
    };
    mkdirSync(recipientEnv.HOME, { mode: 0o700 });
    const extract = run(["tar", "-xzf", archive!, "-C", scratch]);
    expect(extract.exitCode).toBe(0);
    const oldName = readdirSync(scratch).find((name) => name.startsWith("Papertrail-0.1.0-"));
    expect(oldName).toBeTruthy();
    const oldRoot = join(scratch, oldName!);

    ok([
      process.execPath,
      join(oldRoot, "scripts", "lifecycle.ts"),
      "install",
      "--source",
      oldRoot,
      "--install-root",
      installRoot,
      "--data-root",
      dataRoot,
    ], recipientEnv);
    const oldPt = join(installRoot, "bin", "pt");
    okJson([oldPt, "capture", "--json"], {
      input: "Upgrade preservation context",
      intent: "note",
      capturedAt: "2026-08-09T12:00:00.000Z",
      idempotencyKey: "retained-v01-note",
    }, recipientEnv);
    okJson([oldPt, "capture", "--json"], {
      input: "Manual highlight preserved from the retained release",
      intent: "highlight",
      capturedAt: "2026-08-09T12:00:01.000Z",
      idempotencyKey: "retained-v01-highlight",
    }, recipientEnv);
    ok([join(installRoot, "current", "bin", "papertrail-daemon")], {
      ...recipientEnv,
      PAPERTRAIL_ROOT: dataRoot,
      PAPERTRAIL_APP_ROOT: join(installRoot, "current"),
    });
    const ids = ok([oldPt, "recent"], recipientEnv)
      .trim()
      .split("\n")
      .map((line) => line.split("\t")[0]!);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => /^pt_[a-z0-9]{10}$/.test(id))).toBe(true);
    const canonicalPaths = [
      ...new Bun.Glob("items/**/*.md").scanSync({ cwd: dataRoot }),
    ].sort();
    expect(canonicalPaths).toHaveLength(2);
    const canonicalBefore = new Map(
      canonicalPaths.map((path) => [path, readFileSync(join(dataRoot, path))]),
    );
    const configBefore = readFileSync(join(dataRoot, "papertrail.config.json"));
    const historyBefore = git(dataRoot, "log", "--format=%H%x09%s");
    const currentBefore = readlinkSync(join(installRoot, "current"));

    if (suppliedCandidate) verifyDistributionArtifact(candidate);
    else buildDistribution(join(import.meta.dir, ".."), candidate);
    const failed = run([
      join(candidate, "papertrail"),
      "update",
      "--install-root",
      installRoot,
    ], { ...recipientEnv, PAPERTRAIL_TEST_FAIL_AFTER_STAGE: "1" });
    expect(failed.exitCode).not.toBe(0);
    expect(readlinkSync(join(installRoot, "current"))).toBe(currentBefore);
    for (const id of ids) expect(ok([oldPt, "recent"], recipientEnv)).toContain(id);
    for (const [path, bytes] of canonicalBefore) {
      expect(readFileSync(join(dataRoot, path))).toEqual(bytes);
    }

    expect(ok([
      join(candidate, "papertrail"),
      "update",
      "--install-root",
      installRoot,
    ], recipientEnv)).toContain("Local archive ready");
    expect(JSON.parse(readFileSync(join(installRoot, "install.json"), "utf8")))
      .toMatchObject({
        format: 2,
        product: "papertrail",
        dataRoot: realpathSync(dataRoot),
      });
    const upgradedRecent = ok([join(installRoot, "bin", "pt"), "recent"], recipientEnv);
    for (const id of ids) expect(upgradedRecent).toContain(id);
    for (const [path, bytes] of canonicalBefore) {
      expect(readFileSync(join(dataRoot, path))).toEqual(bytes);
    }
    expect(readFileSync(join(dataRoot, "papertrail.config.json"))).toEqual(configBefore);
    expect(git(dataRoot, "log", "--format=%H%x09%s")).toBe(historyBefore);
    const canonicalText = canonicalPaths
      .map((path) => readFileSync(join(dataRoot, path), "utf8"))
      .join("\n");
    expect(canonicalText).toContain("Manual highlight preserved from the retained release");
    expect(canonicalText).toContain("[manual]");
    expect(canonicalText).toContain("Upgrade preservation context");

    expect(ok([join(installRoot, "bin", "papertrail"), "uninstall"], recipientEnv))
      .toContain("Private data preserved");
    expect(existsSync(join(installRoot, "install.json"))).toBe(false);
    for (const [path, bytes] of canonicalBefore) {
      expect(readFileSync(join(dataRoot, path))).toEqual(bytes);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
