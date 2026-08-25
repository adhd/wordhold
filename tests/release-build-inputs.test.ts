import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDistribution,
  verifyDistributionArtifact,
} from "../scripts/build-distribution.ts";

test("a release build installs frozen dependencies outside the source checkout", () => {
  expect(process.platform).toBe("darwin");
  expect(process.arch).toBe("arm64");
  const scratch = mkdtempSync(join(tmpdir(), "wordhold-release-inputs-"));
  try {
    const source = join(scratch, "clean source clone");
    const cloned = Bun.spawnSync([
      "git",
      "clone",
      "-q",
      join(import.meta.dir, ".."),
      source,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(cloned.exitCode).toBe(0);
    expect(existsSync(join(source, "node_modules"))).toBe(false);

    const artifact = buildDistribution(
      source,
      join(scratch, "release artifact"),
      { release: true },
    );
    expect(() => verifyDistributionArtifact(artifact)).not.toThrow();
    expect(existsSync(join(source, "node_modules"))).toBe(false);
    expect(existsSync(join(artifact, "node_modules"))).toBe(false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 180_000);
