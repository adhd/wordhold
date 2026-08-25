import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactManifest } from "../core/artifact.ts";
import {
  remoteReleaseRevision,
  releaseCandidateIdentity,
  type ReleaseReceipt,
  verifyReleaseReceipt,
} from "../scripts/release-candidate.ts";
import {
  authenticatedGithubEnvironment,
  verifyCanonicalRepositoryMetadata,
  verifyRemoteReleaseQualification,
  verifyRemoteReleaseMetadata,
} from "../scripts/verify-release-download.ts";

function manifest(overrides: Partial<ArtifactManifest> = {}): ArtifactManifest {
  return {
    format: 5,
    product: "papertrail",
    version: "0.5.0",
    source: { revision: "a".repeat(40), dirty: false },
    build: {
      platform: "darwin",
      arch: "arm64",
      bunVersion: "1.3.11",
      bunRevision: "af24e281ebacd6ac77c0f14b4206599cf4ae1c9f",
      bunExecutableSha256:
        "1d77af7bfd811aebb7d37bec496a5eed14fe227ded3ab7866d2f39786e8107b6",
      minimumMacOS: "13.0",
      compileAutoload: { dotenv: false, bunfig: false },
      dependencyInstall: "frozen-production-isolated",
      packageJsonSha256: "c".repeat(64),
      bunLockSha256: "d".repeat(64),
    },
    executables: [],
    files: {},
    runtime: {
      externalCommands: ["git"],
      bundledRuntime: {
        name: "bun",
        version: "1.3.11",
        revision: "af24e281ebacd6ac77c0f14b4206599cf4ae1c9f",
      },
      directPackages: {},
    },
    signing: { kind: "adhoc", verified: true },
    releaseId: "b".repeat(64),
    ...overrides,
  };
}

test("release candidate identity binds version, RC, and supported target", () => {
  expect(releaseCandidateIdentity("v0.5.0-rc.2", manifest())).toEqual({
    candidate: "v0.5.0-rc.2",
    version: "0.5.0",
    artifactRootName: "Wordhold-0.5.0-rc.2-darwin-arm64",
    archiveName: "Wordhold-0.5.0-rc.2-darwin-arm64.tar.gz",
    receiptName: "Wordhold-0.5.0-rc.2-darwin-arm64.receipt.json",
  });
  expect(() => releaseCandidateIdentity("v0.5.1-rc.1", manifest()))
    .toThrow(/does not match product version/);
  expect(() => releaseCandidateIdentity("v0.5.0", manifest()))
    .toThrow(/candidate must look like/);
  expect(() => releaseCandidateIdentity(
    "v0.5.0-rc.1",
    manifest({ source: { revision: "a".repeat(40), dirty: true } }),
  )).toThrow(/clean source/);
  expect(() => releaseCandidateIdentity(
    "v0.5.0-rc.1",
    manifest({
      build: {
        ...manifest().build,
        arch: "x64",
      },
    }),
  )).toThrow(/darwin\/arm64/);
  expect(() => releaseCandidateIdentity(
    "v0.5.0-rc.1",
    manifest({
      build: {
        ...manifest().build,
        bunExecutableSha256: "0".repeat(64),
      },
    }),
  )).toThrow(/format-5 build provenance/);
});

test("release receipt binds the exact named archive bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "wordhold-release-receipt-"));
  try {
    const name = "Wordhold-0.5.0-rc.1-darwin-arm64.tar.gz";
    const archive = join(root, name);
    const bytes = Buffer.from("candidate archive bytes\n");
    writeFileSync(archive, bytes);
    const receipt: ReleaseReceipt = {
      format: 2,
      product: "wordhold",
      candidate: "v0.5.0-rc.1",
      version: "0.5.0",
      sourceRevision: "a".repeat(40),
      releaseId: "b".repeat(64),
      target: { platform: "darwin", arch: "arm64", minimumMacOS: "13.0" },
      toolchain: {
        bunVersion: "1.3.11",
        bunRevision: "af24e281ebacd6ac77c0f14b4206599cf4ae1c9f",
        bunExecutableSha256:
          "1d77af7bfd811aebb7d37bec496a5eed14fe227ded3ab7866d2f39786e8107b6",
      },
      artifactRoot: "Wordhold-0.5.0-rc.1-darwin-arm64",
      archive: {
        name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
    const receiptPath = join(
      root,
      "Wordhold-0.5.0-rc.1-darwin-arm64.receipt.json",
    );
    writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(verifyReleaseReceipt(receiptPath, archive)).toEqual(receipt);

    writeFileSync(receiptPath, JSON.stringify({
      ...receipt,
      toolchain: {
        ...receipt.toolchain,
        bunExecutableSha256: "0".repeat(64),
      },
    }));
    expect(() => verifyReleaseReceipt(receiptPath, archive)).toThrow(
      /invalid release receipt identity/,
    );
    writeFileSync(receiptPath, JSON.stringify(receipt));

    const wrongReceiptPath = join(root, "candidate.receipt.json");
    writeFileSync(wrongReceiptPath, JSON.stringify(receipt));
    expect(() => verifyReleaseReceipt(wrongReceiptPath, archive)).toThrow(
      /receipt name does not match receipt identity/,
    );

    writeFileSync(archive, "changed candidate bytes\n");
    expect(() => verifyReleaseReceipt(receiptPath, archive)).toThrow(
      /archive (?:size|SHA-256) does not match receipt/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("downloaded release qualification refuses an incomplete evidence set", () => {
  const result = Bun.spawnSync([
    process.execPath,
    join(import.meta.dir, "..", "scripts", "verify-release-download.ts"),
    "--candidate",
    "v0.5.0-rc.1",
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain(
    "--v01-sha256 HEX",
  );
});

test("hardened Bun producer flags use the supported value syntax", () => {
  const result = Bun.spawnSync([
    process.execPath,
    "--no-env-file",
    "--config=/dev/null",
    "--eval",
    "process.stdout.write('producer-ready')",
  ]);
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe("producer-ready");
});

test("authenticated GitHub queries ignore an inherited non-canonical host", () => {
  expect(authenticatedGithubEnvironment({
    GH_HOST: "attacker.invalid",
    PATH: "/usr/bin",
  })).toEqual({
    GH_HOST: "github.com",
    PATH: "/usr/bin",
  });
});

test("release qualification requires the exact public canonical repository", () => {
  expect(() => verifyCanonicalRepositoryMetadata({
    nameWithOwner: "adhd/wordhold",
    visibility: "PUBLIC",
  })).not.toThrow();
  expect(() => verifyCanonicalRepositoryMetadata({
    nameWithOwner: "adhd/wordhold",
    visibility: "PRIVATE",
  })).toThrow(/verified public/i);
  expect(() => verifyCanonicalRepositoryMetadata({
    nameWithOwner: "someone-else/wordhold",
    visibility: "PUBLIC",
  })).toThrow(/verified public/i);
});

test("published qualification rechecks refs after immutable release metadata", () => {
  const observations: string[] = [];
  verifyRemoteReleaseQualification(
    "published",
    () => observations.push("refs"),
    () => observations.push("immutable metadata"),
  );
  expect(observations).toEqual([
    "refs",
    "immutable metadata",
    "refs",
  ]);
});

test("draft qualification keeps a single pre-metadata ref check", () => {
  const observations: string[] = [];
  verifyRemoteReleaseQualification(
    "draft",
    () => observations.push("refs"),
    () => observations.push("draft metadata"),
  );
  expect(observations).toEqual(["refs", "draft metadata"]);
});

test("remote release identity binds canonical main, tag, immutable state, and assets", () => {
  expect(remoteReleaseRevision(
    [
      `${"a".repeat(40)}\trefs/heads/main`,
      `${"c".repeat(40)}\trefs/tags/v0.5.0-rc.1`,
      `${"a".repeat(40)}\trefs/tags/v0.5.0-rc.1^{}`,
    ].join("\n"),
    "v0.5.0-rc.1",
  )).toEqual({ main: "a".repeat(40), tag: "a".repeat(40) });

  const releaseReceipt = {
    format: 2,
    product: "wordhold",
    candidate: "v0.5.0-rc.1",
    version: "0.5.0",
    sourceRevision: "a".repeat(40),
    releaseId: "b".repeat(64),
    target: { platform: "darwin", arch: "arm64", minimumMacOS: "13.0" },
    toolchain: {
      bunVersion: "1.3.11",
      bunRevision: "af24e281ebacd6ac77c0f14b4206599cf4ae1c9f",
      bunExecutableSha256:
        "1d77af7bfd811aebb7d37bec496a5eed14fe227ded3ab7866d2f39786e8107b6",
    },
    artifactRoot: "Wordhold-0.5.0-rc.1-darwin-arm64",
    archive: {
      name: "Wordhold-0.5.0-rc.1-darwin-arm64.tar.gz",
      bytes: 123,
      sha256: "d".repeat(64),
    },
  } satisfies ReleaseReceipt;
  const metadata = {
    tagName: "v0.5.0-rc.1",
    isDraft: false,
    isPrerelease: true,
    isImmutable: true,
    assets: [
      {
        name: releaseReceipt.archive.name,
        size: releaseReceipt.archive.bytes,
        digest: `sha256:${releaseReceipt.archive.sha256}`,
      },
      {
        name: "Wordhold-0.5.0-rc.1-darwin-arm64.receipt.json",
        size: 456,
        digest: `sha256:${"e".repeat(64)}`,
      },
    ],
  };
  expect(() => verifyRemoteReleaseMetadata(
    metadata,
    "published",
    releaseReceipt,
    { bytes: 456, sha256: "e".repeat(64) },
  )).not.toThrow();
  expect(() => verifyRemoteReleaseMetadata(
    { ...metadata, isImmutable: false },
    "published",
    releaseReceipt,
    { bytes: 456, sha256: "e".repeat(64) },
  )).toThrow(/published immutable prerelease/);
});
