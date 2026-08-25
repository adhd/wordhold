import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactReleaseId,
  buildDistribution,
  verifyDistributionArtifact,
  type ArtifactManifest,
} from "../scripts/build-distribution.ts";

let scratch: string;
let artifact: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "pt-release-artifact-"));
  artifact = buildDistribution(
    join(import.meta.dir, ".."),
    join(scratch, "artifact"),
  );
}, 120_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function clone(name: string): string {
  const destination = join(scratch, name);
  cpSync(artifact, destination, { recursive: true });
  return destination;
}

function rewriteManifest(
  root: string,
  update: (manifest: ArtifactManifest) => void,
): void {
  const path = join(root, ".papertrail-artifact.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as ArtifactManifest;
  update(manifest);
  manifest.releaseId = artifactReleaseId(manifest);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

test("sanitized output is a self-contained, target-identified release", () => {
  const verified = verifyDistributionArtifact(artifact);
  expect(verified.manifest.format).toBe(5);
  expect(verified.manifest.version).toBe("0.5.0");
  expect(verified.manifest.source.revision).toMatch(/^[0-9a-f]{40}$/);
  expect(typeof verified.manifest.source.dirty).toBe("boolean");
  expect(verified.manifest.build).toEqual({
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    bunExecutableSha256: createHash("sha256")
      .update(readFileSync(process.execPath))
      .digest("hex"),
    minimumMacOS: "13.0",
    compileAutoload: { dotenv: false, bunfig: false },
    dependencyInstall: "ambient-development",
    packageJsonSha256: createHash("sha256")
      .update(readFileSync(join(artifact, "package.json")))
      .digest("hex"),
    bunLockSha256: createHash("sha256")
      .update(readFileSync(join(artifact, "bun.lock")))
      .digest("hex"),
  });
  expect(verified.manifest.runtime).toMatchObject({
    externalCommands: ["git"],
    bundledRuntime: { name: "bun", version: Bun.version, revision: Bun.revision },
  });
  expect(verified.manifest.signing).toEqual({ kind: "adhoc", verified: true });
  expect(verified.manifest.executables).toEqual([
    "wordhold",
    "papertrail",
    "bin/papertrail-daemon",
    "bin/papertrail-digest",
    "bin/papertrail-enrich",
    "bin/papertrail-mcp",
    "bin/papertrail-resurface",
    "bin/pt",
  ]);
  expect(existsSync(join(artifact, "node_modules"))).toBe(false);
  expect(existsSync(join(artifact, ".git"))).toBe(false);
  expect(existsSync(join(artifact, "items"))).toBe(false);
  for (const path of verified.manifest.executables) {
    const stat = lstatSync(join(artifact, path));
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111).not.toBe(0);
    expect(
      Bun.spawnSync(["codesign", "--verify", "--strict", join(artifact, path)]).exitCode,
      path,
    ).toBe(0);
  }
});

test("verification rejects unlisted files and symlinks", () => {
  const extra = clone("extra");
  writeFileSync(join(extra, "EXTRA"), "not declared\n");
  expect(() => verifyDistributionArtifact(extra)).toThrow(/unlisted/i);

  const linked = clone("linked");
  symlinkSync("README.md", join(linked, "README-link.md"));
  expect(() => verifyDistributionArtifact(linked)).toThrow(/symbolic/i);
});

test("verification rejects private members even when declared", () => {
  for (const member of [
    "items/private.md",
    ".git/config",
    ".env.local",
    "worker/.dev.vars",
    ".scratch/issue.md",
  ]) {
    const root = clone(`private-${member.replaceAll(/[^a-z0-9]+/gi, "-")}`);
    const path = join(root, member);
    const parent = path.slice(0, path.lastIndexOf("/"));
    mkdirSync(parent, { recursive: true });
    writeFileSync(path, "private\n");
    // Declare and re-identify the member so this exercises the private-member
    // boundary rather than the simpler unlisted-file failure.
    rewriteManifest(root, (manifest) => {
      manifest.files[member] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
    });
    expect(existsSync(parent)).toBe(true);
    expect(() => verifyDistributionArtifact(root)).toThrow(/private member/i);
  }
});

test("verification rejects content tampering and lost executable modes", () => {
  const changed = clone("changed");
  writeFileSync(join(changed, "README.md"), "tampered\n");
  expect(() => verifyDistributionArtifact(changed)).toThrow(/hash mismatch/i);

  const mode = clone("mode");
  chmodSync(join(mode, "bin", "pt"), 0o600);
  expect(() => verifyDistributionArtifact(mode)).toThrow(/not executable/i);
});

test("format 5 requires legal provenance and exact bundled runtime provenance", () => {
  const missingNotice = clone("missing-required-notice");
  rmSync(join(missingNotice, "NOTICE"));
  rewriteManifest(missingNotice, (manifest) => {
    delete manifest.files.NOTICE;
  });
  expect(() => verifyDistributionArtifact(missingNotice))
    .toThrow(/missing required legal\/provenance member: NOTICE/);

  const wrongRuntime = clone("wrong-runtime-revision");
  rewriteManifest(wrongRuntime, (manifest) => {
    manifest.runtime!.bundledRuntime.revision = "0".repeat(40);
  });
  expect(() => verifyDistributionArtifact(wrongRuntime))
    .toThrow(/invalid Wordhold artifact build provenance/);
});

test("verification rejects a release built for another host target", () => {
  expect(() =>
    verifyDistributionArtifact(artifact, {
      platform: process.platform,
      arch: `${process.arch}-other`,
    })
  ).toThrow(/incompatible artifact target/i);
  expect(() =>
    verifyDistributionArtifact(artifact, {
      platform: "darwin",
      arch: "arm64",
      macOSVersion: "12.6",
    })
  ).toThrow(/requires 13\.0 or newer/i);
});

test("artifact formats bind the exact pre- and post-Wordhold executable inventories", () => {
  const exactPapertrail = clone("format-3-exact");
  rmSync(join(exactPapertrail, "wordhold"));
  rewriteManifest(exactPapertrail, (manifest) => {
    manifest.format = 3;
    manifest.executables = manifest.executables.filter((path) => path !== "wordhold");
    delete manifest.files.wordhold;
  });
  expect(() => verifyDistributionArtifact(exactPapertrail)).not.toThrow();

  const papertrailWithWordhold = clone("format-3-with-wordhold");
  rewriteManifest(papertrailWithWordhold, (manifest) => {
    manifest.format = 3;
  });
  expect(() => verifyDistributionArtifact(papertrailWithWordhold))
    .toThrow("artifact executable inventory mismatch");

  const wordholdWithoutLauncher = clone("format-4-without-wordhold");
  rmSync(join(wordholdWithoutLauncher, "wordhold"));
  rewriteManifest(wordholdWithoutLauncher, (manifest) => {
    manifest.executables = manifest.executables.filter((path) => path !== "wordhold");
    delete manifest.files.wordhold;
  });
  expect(() => verifyDistributionArtifact(wordholdWithoutLauncher))
    .toThrow("artifact executable inventory mismatch");
});

test("builder refuses output overlap before creating it", () => {
  const sourceRoot = join(import.meta.dir, "..");
  const nested = join(sourceRoot, "core", "nested-artifact-test");
  expect(() => buildDistribution(sourceRoot, nested)).toThrow(/must not overlap/i);
  expect(existsSync(nested)).toBe(false);
});

test("builder rejects unreviewed and symbolic source members", () => {
  const sourceRoot = join(import.meta.dir, "..");
  const untracked = join(sourceRoot, "core", "release-secret-test.txt");
  writeFileSync(untracked, "not reviewed\n");
  try {
    expect(() => buildDistribution(sourceRoot, join(scratch, "untracked-source")))
      .toThrow(/source tree differs from Git inventory; untracked/i);
  } finally {
    rmSync(untracked, { force: true });
  }

  const linked = join(sourceRoot, "core", "release-secret-link-test.txt");
  symlinkSync("../README.md", linked);
  try {
    expect(() => buildDistribution(sourceRoot, join(scratch, "linked-source")))
      .toThrow(/symbolic link/i);
  } finally {
    rmSync(linked, { force: true });
  }
});
