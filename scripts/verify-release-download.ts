// Fail-closed qualification for the two assets downloaded from a GitHub
// release. The test harness may use source code, but every product command it
// exercises comes from this exact authenticated archive extraction.
import { createHash } from "node:crypto";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  WORDHOLD_ARTIFACT_FORMAT,
  verifyDistributionArtifact,
} from "../core/artifact.ts";
import {
  type ReleaseReceipt,
  verifyCanonicalRemoteState,
  verifyReleaseReceipt,
} from "./release-candidate.ts";
import { verifySourceBoundary } from "./verify-source-boundary.ts";

const CANONICAL_REPOSITORY = "adhd/wordhold";
const RETAINED_V01_SHA256 =
  "d4e24a228a67de6b3494ce9c2f3bb056528f51952f7022b0b36c381c7be590f1";
export type ReleaseState = "draft" | "published";

export function verifyRemoteReleaseQualification(
  state: ReleaseState,
  verifyRemoteState: () => void,
  verifyMetadata: () => void,
): void {
  verifyRemoteState();
  verifyMetadata();
  if (state === "published") verifyRemoteState();
}

export function verifyCanonicalRepositoryMetadata(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("canonical GitHub repository is not verified public");
  }
  const repository = raw as {
    nameWithOwner?: unknown;
    visibility?: unknown;
  };
  if (
    repository.nameWithOwner !== CANONICAL_REPOSITORY ||
    repository.visibility !== "PUBLIC"
  ) {
    throw new Error("canonical GitHub repository is not verified public");
  }
}

export function verifyRemoteReleaseMetadata(
  raw: unknown,
  state: ReleaseState,
  receipt: ReleaseReceipt,
  receiptAsset: { bytes: number; sha256: string },
): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid GitHub release metadata");
  }
  const metadata = raw as {
    tagName?: unknown;
    isDraft?: unknown;
    isPrerelease?: unknown;
    isImmutable?: unknown;
    assets?: unknown;
  };
  const expectedState = state === "draft"
    ? { isDraft: true, isPrerelease: true, isImmutable: false }
    : { isDraft: false, isPrerelease: true, isImmutable: true };
  if (
    metadata.tagName !== receipt.candidate ||
    metadata.isDraft !== expectedState.isDraft ||
    metadata.isPrerelease !== expectedState.isPrerelease ||
    metadata.isImmutable !== expectedState.isImmutable
  ) {
    throw new Error(
      state === "draft"
        ? "GitHub release is not the expected draft prerelease"
        : "GitHub release is not the expected published immutable prerelease",
    );
  }
  if (!Array.isArray(metadata.assets) || metadata.assets.length !== 2) {
    throw new Error("GitHub release must contain exactly two assets");
  }
  const expected = new Map([
    [receipt.archive.name, {
      bytes: receipt.archive.bytes,
      sha256: receipt.archive.sha256,
    }],
    [`${receipt.artifactRoot}.receipt.json`, receiptAsset],
  ]);
  for (const rawAsset of metadata.assets) {
    if (!rawAsset || typeof rawAsset !== "object" || Array.isArray(rawAsset)) {
      throw new Error("invalid GitHub release asset metadata");
    }
    const asset = rawAsset as { name?: unknown; size?: unknown; digest?: unknown };
    if (typeof asset.name !== "string") {
      throw new Error("invalid GitHub release asset name");
    }
    const wanted = expected.get(asset.name);
    if (
      !wanted ||
      asset.size !== wanted.bytes ||
      asset.digest !== `sha256:${wanted.sha256}`
    ) {
      throw new Error(`GitHub release asset identity mismatch: ${asset.name}`);
    }
    expected.delete(asset.name);
  }
  if (expected.size) throw new Error("GitHub release asset is missing");
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function run(
  args: string[],
  options: Parameters<typeof Bun.spawnSync>[1] = {},
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(args, {
    stdout: "pipe",
    stderr: "pipe",
    ...options,
  });
}

function checked(
  args: string[],
  options: Parameters<typeof Bun.spawnSync>[1] = {},
): string {
  const result = run(args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${args[0]} failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

export function authenticatedGithubEnvironment(
  inherited: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return { ...inherited, GH_HOST: "github.com" };
}

function checkedGithub(args: string[]): string {
  return checked(["gh", ...args], {
    env: authenticatedGithubEnvironment(),
  });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeArchiveMembers(listing: string, root: string): void {
  const members = listing.split("\n").filter(Boolean);
  if (!members.length) throw new Error("release archive is empty");
  for (const member of members) {
    if (
      member.startsWith("/") ||
      member.includes("\\") ||
      member.split("/").some((part) => part === "..") ||
      (member !== root && member !== `${root}/` && !member.startsWith(`${root}/`))
    ) {
      throw new Error(`release archive contains an unsafe member: ${member}`);
    }
  }
}

export function verifyDownloadedRelease(options: {
  sourceRoot: string;
  candidate: string;
  archive: string;
  receipt: string;
  v01Archive: string;
  v01Sha256: string;
  releaseState: ReleaseState;
}): {
  candidate: string;
  revision: string;
  releaseId: string;
  bytes: number;
  sha256: string;
  signatures: number;
} {
  const sourceRoot = realpathSync(resolve(options.sourceRoot));
  const archive = resolve(options.archive);
  const receiptPath = resolve(options.receipt);
  const v01Archive = resolve(options.v01Archive);
  if (dirname(archive) !== dirname(receiptPath)) {
    throw new Error("downloaded archive and receipt must share one fresh directory");
  }
  const downloadedNames = readdirSync(dirname(archive)).sort();
  const expectedNames = [archive, receiptPath]
    .map((path) => path.split("/").at(-1)!)
    .sort();
  if (JSON.stringify(downloadedNames) !== JSON.stringify(expectedNames)) {
    throw new Error("release download directory must contain only the archive and receipt");
  }
  if (options.v01Sha256 !== RETAINED_V01_SHA256) {
    throw new Error("v0.1 SHA-256 must be the pinned retained-release digest");
  }
  if (
    !existsSync(v01Archive) ||
    lstatSync(v01Archive).isSymbolicLink() ||
    !lstatSync(v01Archive).isFile()
  ) {
    throw new Error("retained v0.1 archive must be a regular file");
  }
  // Validate the originals before copying, then verify and use only private
  // snapshots. A same-size replacement of either input during later tests
  // cannot change the bytes being qualified.
  verifyReleaseReceipt(receiptPath, archive);
  const source = verifySourceBoundary({
    root: sourceRoot,
    requireCanonicalReleaseContext: true,
  });

  const scratch = mkdtempSync(join(tmpdir(), "Wordhold release verification with spaces-"));
  try {
    const snapshotRoot = join(scratch, "authenticated snapshots");
    const extractionRoot = join(scratch, "extracted candidate");
    mkdirSync(snapshotRoot, { mode: 0o700 });
    mkdirSync(extractionRoot, { mode: 0o700 });
    const snapshotArchive = join(snapshotRoot, receiptPath.split("/").at(-1)!.replace(
      ".receipt.json",
      ".tar.gz",
    ));
    const snapshotReceipt = join(snapshotRoot, receiptPath.split("/").at(-1)!);
    const snapshotV01 = join(snapshotRoot, v01Archive.split("/").at(-1)!);
    copyFileSync(archive, snapshotArchive);
    copyFileSync(receiptPath, snapshotReceipt);
    copyFileSync(v01Archive, snapshotV01);

    const receipt = verifyReleaseReceipt(snapshotReceipt, snapshotArchive);
    if (receipt.candidate !== options.candidate) {
      throw new Error("downloaded receipt does not match the requested candidate");
    }
    if (sha256(snapshotV01) !== options.v01Sha256) {
      throw new Error("retained v0.1 archive SHA-256 mismatch");
    }
    if (source.revision !== receipt.sourceRevision) {
      throw new Error("source HEAD and release receipt revision differ");
    }
    verifyRemoteReleaseQualification(
      options.releaseState,
      () => verifyCanonicalRemoteState(
        sourceRoot,
        options.candidate,
        receipt.sourceRevision,
      ),
      () => {
        const repository: unknown = JSON.parse(checkedGithub([
          "repo",
          "view",
          CANONICAL_REPOSITORY,
          "--json",
          "nameWithOwner,visibility",
        ]));
        verifyCanonicalRepositoryMetadata(repository);
        const metadata: unknown = JSON.parse(checkedGithub([
          "release",
          "view",
          options.candidate,
          "--repo",
          CANONICAL_REPOSITORY,
          "--json",
          "tagName,isDraft,isPrerelease,isImmutable,assets",
        ]));
        verifyRemoteReleaseMetadata(metadata, options.releaseState, receipt, {
          bytes: statSync(snapshotReceipt).size,
          sha256: sha256(snapshotReceipt),
        });
      },
    );

    const names = checked(["tar", "-tzf", snapshotArchive])
      .split("\n")
      .filter(Boolean);
    safeArchiveMembers(names.join("\n"), receipt.artifactRoot);
    const verbose = checked(["tar", "-tzvf", snapshotArchive]);
    if (verbose.split("\n").filter(Boolean).some(
      (line) => !/^[d-]\S*\s+\d+\s+root\s+wheel\s+/.test(line),
    )) {
      throw new Error("release archive contains non-neutral ownership metadata");
    }
    checked(["tar", "-xzf", snapshotArchive, "-C", extractionRoot]);
    if (
      JSON.stringify(readdirSync(extractionRoot)) !==
        JSON.stringify([receipt.artifactRoot])
    ) {
      throw new Error("release archive must extract to exactly one expected root");
    }
    const artifact = join(extractionRoot, receipt.artifactRoot);
    const { manifest } = verifyDistributionArtifact(artifact);
    if (
      manifest.format !== WORDHOLD_ARTIFACT_FORMAT ||
      manifest.version !== receipt.version ||
      manifest.source.revision !== receipt.sourceRevision ||
      manifest.source.dirty ||
      manifest.releaseId !== receipt.releaseId ||
      manifest.build.platform !== receipt.target.platform ||
      manifest.build.arch !== receipt.target.arch ||
      manifest.build.minimumMacOS !== receipt.target.minimumMacOS ||
      manifest.build.bunVersion !== receipt.toolchain.bunVersion ||
      manifest.build.bunRevision !== receipt.toolchain.bunRevision ||
      manifest.build.bunExecutableSha256 !== receipt.toolchain.bunExecutableSha256 ||
      manifest.build.compileAutoload?.dotenv !== false ||
      manifest.build.compileAutoload?.bunfig !== false ||
      manifest.build.dependencyInstall !== "frozen-production-isolated" ||
      manifest.runtime?.bundledRuntime.revision !== receipt.toolchain.bunRevision
    ) {
      throw new Error("extracted artifact manifest does not match release receipt");
    }
    for (const executable of manifest.executables) {
      checked(["codesign", "--verify", "--strict", join(artifact, executable)]);
    }

    const tests = Bun.spawnSync([
      process.execPath,
      "test",
      "tests/guided-setup.test.ts",
      "tests/v01-upgrade.test.ts",
    ], {
      cwd: sourceRoot,
      env: {
        ...process.env,
        WORDHOLD_RELEASE_ARTIFACT: artifact,
        PAPERTRAIL_V01_ARCHIVE: snapshotV01,
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    if (tests.exitCode !== 0) {
      throw new Error("downloaded release lifecycle or retained-upgrade qualification failed");
    }
    return {
      candidate: receipt.candidate,
      revision: receipt.sourceRevision,
      releaseId: receipt.releaseId,
      bytes: statSync(snapshotArchive).size,
      sha256: receipt.archive.sha256,
      signatures: manifest.executables.length,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const candidate = argument("--candidate");
  const archive = argument("--archive");
  const receipt = argument("--receipt");
  const v01Archive = argument("--v01-archive");
  const v01Sha256 = argument("--v01-sha256");
  const releaseState = argument("--release-state");
  if (
    !candidate ||
    !archive ||
    !receipt ||
    !v01Archive ||
    !v01Sha256 ||
    (releaseState !== "draft" && releaseState !== "published")
  ) {
    throw new Error(
      "usage: verify-release-download --release-state draft|published --candidate v0.5.0-rc.N --archive FILE.tar.gz --receipt FILE.receipt.json --v01-archive FILE.tar.gz --v01-sha256 HEX",
    );
  }
  const result = verifyDownloadedRelease({
    sourceRoot: dirname(import.meta.dir),
    candidate,
    archive,
    receipt,
    v01Archive,
    v01Sha256,
    releaseState,
  });
  console.log(JSON.stringify({
    status: `downloaded-${releaseState}-release-qualified`,
    ...result,
  }));
}
