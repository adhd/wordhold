// Release-only orchestration: bind one reviewed RC tag to one clean compiled
// archive and a path-free receipt. This file is intentionally not distributed.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  WORDHOLD_ARTIFACT_FORMAT,
  WORDHOLD_MINIMUM_MACOS,
  type ArtifactManifest,
} from "../core/artifact.ts";
import {
  buildDistribution,
  verifyDistributionArtifact,
} from "./build-distribution.ts";
import { packageDistribution } from "./package-distribution.ts";
import { verifySourceBoundary } from "./verify-source-boundary.ts";
import {
  BUN_DARWIN_ARM64_EXECUTABLE_SHA256,
  BUN_RUNTIME_REVISION,
  BUN_RUNTIME_VERSION,
} from "./verify-third-party-licenses.ts";

export interface ReleaseCandidateIdentity {
  candidate: string;
  version: string;
  artifactRootName: string;
  archiveName: string;
  receiptName: string;
}

export interface ReleaseReceipt {
  format: 2;
  product: "wordhold";
  candidate: string;
  version: string;
  sourceRevision: string;
  releaseId: string;
  target: { platform: "darwin"; arch: "arm64"; minimumMacOS: string };
  toolchain: {
    bunVersion: string;
    bunRevision: string;
    bunExecutableSha256: string;
  };
  artifactRoot: string;
  archive: { name: string; bytes: number; sha256: string };
}

export function remoteReleaseRevision(
  output: string,
  candidate: string,
): { main: string; tag: string } {
  const refs = new Map(
    output.split("\n").filter(Boolean).map((line) => {
      const [revision, ref, extra] = line.split("\t");
      if (extra || !revision || !ref || !/^[0-9a-f]{40}$/.test(revision)) {
        throw new Error("canonical remote returned malformed ref data");
      }
      return [ref, revision] as const;
    }),
  );
  const main = refs.get("refs/heads/main");
  const tag = refs.get(`refs/tags/${candidate}^{}`) ??
    refs.get(`refs/tags/${candidate}`);
  if (!main || !tag) {
    throw new Error("canonical remote is missing main or the candidate tag");
  }
  return { main, tag };
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`invalid release receipt ${label}`);
  }
}

export function verifyReleaseReceipt(
  receiptPath: string,
  archivePath: string,
): ReleaseReceipt {
  if (
    !existsSync(receiptPath) ||
    lstatSync(receiptPath).isSymbolicLink() ||
    !lstatSync(receiptPath).isFile()
  ) {
    throw new Error("release receipt must be a regular file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch {
    throw new Error("invalid release receipt JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid release receipt");
  }
  const receipt = parsed as ReleaseReceipt;
  exactKeys(receipt as unknown as Record<string, unknown>, [
    "format",
    "product",
    "candidate",
    "version",
    "sourceRevision",
    "releaseId",
    "target",
    "toolchain",
    "artifactRoot",
    "archive",
  ], "fields");
  if (!receipt.target || typeof receipt.target !== "object") {
    throw new Error("invalid release receipt target");
  }
  if (!receipt.toolchain || typeof receipt.toolchain !== "object") {
    throw new Error("invalid release receipt toolchain");
  }
  if (!receipt.archive || typeof receipt.archive !== "object") {
    throw new Error("invalid release receipt archive");
  }
  exactKeys(
    receipt.target as unknown as Record<string, unknown>,
    ["platform", "arch", "minimumMacOS"],
    "target fields",
  );
  exactKeys(
    receipt.toolchain as unknown as Record<string, unknown>,
    ["bunVersion", "bunRevision", "bunExecutableSha256"],
    "toolchain fields",
  );
  exactKeys(receipt.archive as unknown as Record<string, unknown>, ["name", "bytes", "sha256"], "archive fields");
  const version = candidateVersion(receipt.candidate);
  const stem = `Wordhold-${receipt.candidate.slice(1)}-darwin-arm64`;
  if (
    receipt.format !== 2 ||
    receipt.product !== "wordhold" ||
    receipt.version !== version ||
    !/^[0-9a-f]{40}$/.test(receipt.sourceRevision) ||
    !/^[0-9a-f]{64}$/.test(receipt.releaseId) ||
    receipt.target.platform !== "darwin" ||
    receipt.target.arch !== "arm64" ||
    receipt.target.minimumMacOS !== WORDHOLD_MINIMUM_MACOS ||
    receipt.toolchain.bunVersion !== BUN_RUNTIME_VERSION ||
    receipt.toolchain.bunRevision !== BUN_RUNTIME_REVISION ||
    receipt.toolchain.bunExecutableSha256 !==
      BUN_DARWIN_ARM64_EXECUTABLE_SHA256 ||
    receipt.artifactRoot !== stem ||
    receipt.archive.name !== `${stem}.tar.gz` ||
    !Number.isSafeInteger(receipt.archive.bytes) ||
    receipt.archive.bytes <= 0 ||
    !/^[0-9a-f]{64}$/.test(receipt.archive.sha256)
  ) {
    throw new Error("invalid release receipt identity");
  }
  if (basename(receiptPath) !== `${stem}.receipt.json`) {
    throw new Error("receipt name does not match receipt identity");
  }
  if (
    basename(archivePath) !== receipt.archive.name ||
    !existsSync(archivePath) ||
    lstatSync(archivePath).isSymbolicLink() ||
    !lstatSync(archivePath).isFile()
  ) {
    throw new Error("archive name or type does not match receipt");
  }
  if (statSync(archivePath).size !== receipt.archive.bytes) {
    throw new Error("archive size does not match receipt");
  }
  const digest = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (digest !== receipt.archive.sha256) {
    throw new Error("archive SHA-256 does not match receipt");
  }
  return receipt;
}

function candidateVersion(candidate: string): string {
  const match = /^v(\d+\.\d+\.\d+)-rc\.([1-9]\d*)$/.exec(candidate);
  if (!match) throw new Error("candidate must look like v0.5.0-rc.1");
  return match[1]!;
}

export function releaseCandidateIdentity(
  candidate: string,
  manifest: ArtifactManifest,
): ReleaseCandidateIdentity {
  const version = candidateVersion(candidate);
  if (manifest.version !== version) {
    throw new Error(
      `candidate ${candidate} does not match product version ${manifest.version}`,
    );
  }
  if (manifest.source.dirty) {
    throw new Error("release candidate requires a clean source revision");
  }
  if (
    manifest.format !== WORDHOLD_ARTIFACT_FORMAT ||
    manifest.build.minimumMacOS !== WORDHOLD_MINIMUM_MACOS ||
    manifest.build.bunVersion !== BUN_RUNTIME_VERSION ||
    manifest.build.bunRevision !== BUN_RUNTIME_REVISION ||
    manifest.build.bunExecutableSha256 !== BUN_DARWIN_ARM64_EXECUTABLE_SHA256 ||
    manifest.build.compileAutoload?.dotenv !== false ||
    manifest.build.compileAutoload?.bunfig !== false ||
    manifest.build.dependencyInstall !== "frozen-production-isolated" ||
    !/^[0-9a-f]{64}$/.test(manifest.build.packageJsonSha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(manifest.build.bunLockSha256 ?? "") ||
    !/^[0-9a-f]{40}$/.test(manifest.build.bunRevision ?? "") ||
    !/^[0-9a-f]{64}$/.test(manifest.build.bunExecutableSha256 ?? "")
  ) {
    throw new Error("release candidate requires complete format-5 build provenance");
  }
  if (manifest.build.platform !== "darwin" || manifest.build.arch !== "arm64") {
    throw new Error("v0.5 release candidates must target darwin/arm64");
  }
  const stem = `Wordhold-${candidate.slice(1)}-${manifest.build.platform}-${manifest.build.arch}`;
  return {
    candidate,
    version,
    artifactRootName: stem,
    archiveName: `${stem}.tar.gz`,
    receiptName: `${stem}.receipt.json`,
  };
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

export function verifyCanonicalRemoteState(
  root: string,
  candidate: string,
  revision: string,
): void {
  if (git(root, ["remote"]) !== "origin") {
    throw new Error("release qualification requires the canonical origin remote");
  }
  const trackedMain = git(root, ["rev-parse", "refs/remotes/origin/main"]);
  const remote = remoteReleaseRevision(
    git(root, [
      "ls-remote",
      "origin",
      "refs/heads/main",
      `refs/tags/${candidate}`,
      `refs/tags/${candidate}^{}`,
    ]),
    candidate,
  );
  if (
    trackedMain !== revision ||
    remote.main !== revision ||
    remote.tag !== revision
  ) {
    throw new Error(
      "source HEAD, origin/main, remote main, and candidate tag must match",
    );
  }
}

export function prepareReleaseCandidate(options: {
  sourceRoot: string;
  outputRoot: string;
  candidate: string;
}): { artifact: string; archive: string; receipt: string; data: ReleaseReceipt } {
  const sourceRoot = resolve(options.sourceRoot);
  const outputRoot = resolve(options.outputRoot);
  if (existsSync(outputRoot)) {
    throw new Error(`release output already exists: ${outputRoot}`);
  }
  const version = candidateVersion(options.candidate);
  const packageVersion = (JSON.parse(
    readFileSync(join(sourceRoot, "package.json"), "utf8"),
  ) as { version?: unknown }).version;
  if (packageVersion !== version) {
    throw new Error(`candidate ${options.candidate} does not match package version ${packageVersion}`);
  }
  const revision = git(sourceRoot, ["rev-parse", "HEAD"]);
  const tagRevision = git(sourceRoot, ["rev-parse", `${options.candidate}^{commit}`]);
  if (tagRevision !== revision) {
    throw new Error("candidate tag must resolve to the checked-out source revision");
  }
  verifySourceBoundary({
    root: sourceRoot,
    requireCanonicalReleaseContext: true,
  });
  verifyCanonicalRemoteState(sourceRoot, options.candidate, revision);

  const stem = `Wordhold-${options.candidate.slice(1)}-${process.platform}-${process.arch}`;
  mkdirSync(dirname(outputRoot), { recursive: true, mode: 0o700 });
  mkdirSync(outputRoot, { mode: 0o700 });
  try {
    const artifact = buildDistribution(sourceRoot, join(outputRoot, stem), {
      release: true,
    });
    const { manifest } = verifyDistributionArtifact(artifact);
    const identity = releaseCandidateIdentity(options.candidate, manifest);
    if (identity.artifactRootName !== stem || manifest.source.revision !== revision) {
      throw new Error("candidate artifact identity does not match its source tag");
    }
    const packaged = packageDistribution(
      artifact,
      join(outputRoot, identity.archiveName),
    );
    const data: ReleaseReceipt = {
      format: 2,
      product: "wordhold",
      candidate: identity.candidate,
      version: identity.version,
      sourceRevision: manifest.source.revision,
      releaseId: manifest.releaseId,
      target: {
        platform: "darwin",
        arch: "arm64",
        minimumMacOS: manifest.build.minimumMacOS!,
      },
      toolchain: {
        bunVersion: manifest.build.bunVersion,
        bunRevision: manifest.build.bunRevision!,
        bunExecutableSha256: manifest.build.bunExecutableSha256!,
      },
      artifactRoot: identity.artifactRootName,
      archive: {
        name: identity.archiveName,
        bytes: packaged.bytes,
        sha256: packaged.sha256,
      },
    };
    const receipt = join(outputRoot, identity.receiptName);
    writeFileSync(receipt, JSON.stringify(data, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    if (statSync(packaged.archive).size !== data.archive.bytes) {
      throw new Error("candidate archive size changed while writing its receipt");
    }
    return { artifact, archive: packaged.archive, receipt, data };
  } catch (error) {
    rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const candidate = argument("--candidate");
  const outputRoot = argument("--output");
  if (!candidate || !outputRoot) {
    throw new Error(
      "usage: release-candidate --candidate v0.5.0-rc.N --output NEW_DIRECTORY",
    );
  }
  const result = prepareReleaseCandidate({
    sourceRoot: dirname(import.meta.dir),
    outputRoot,
    candidate,
  });
  console.log(JSON.stringify({
    status: "candidate-prepared",
    candidate: result.data.candidate,
    revision: result.data.sourceRevision,
    releaseId: result.data.releaseId,
    archive: result.archive,
    receipt: result.receipt,
    bytes: result.data.archive.bytes,
    sha256: result.data.archive.sha256,
  }));
}
