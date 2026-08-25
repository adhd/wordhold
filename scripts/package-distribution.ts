// Creates the actual handoff unit with neutral tar ownership. Plain `tar -czf`
// on macOS records the builder's account name in every member header, which is
// a privacy leak even when the payload itself is sanitized.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { verifyDistributionArtifact } from "../core/artifact.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function packageDistribution(
  rawArtifactRoot: string,
  rawArchivePath: string,
  options: { allowDirty?: boolean } = {},
): { archive: string; bytes: number; sha256: string } {
  if (process.platform !== "darwin") {
    throw new Error("release archive packaging currently requires macOS bsdtar");
  }
  const artifactRoot = realpathSync(resolve(rawArtifactRoot));
  const requestedArchive = isAbsolute(rawArchivePath)
    ? rawArchivePath
    : resolve(rawArchivePath);
  const archiveParent = realpathSync(dirname(requestedArchive));
  const archive = join(archiveParent, basename(requestedArchive));
  const original = verifyDistributionArtifact(artifactRoot);
  if (original.manifest.source.dirty && !options.allowDirty) {
    throw new Error("refusing to package a dirty-source artifact");
  }
  if (!archive.endsWith(".tar.gz")) {
    throw new Error("release archive path must end in .tar.gz");
  }
  if (existsSync(archive)) {
    throw new Error(`release archive already exists: ${archive}`);
  }
  if (archive.startsWith(`${artifactRoot}/`)) {
    throw new Error("release archive must be outside the artifact directory");
  }
  const work = mkdtempSync(join(archiveParent, ".papertrail-package-"));
  const snapshot = join(work, basename(artifactRoot));
  const stage = join(work, "release.tar.gz");
  try {
    cpSync(artifactRoot, snapshot, { recursive: true, errorOnExist: true });
    const copied = verifyDistributionArtifact(snapshot);
    if (copied.raw !== original.raw) {
      throw new Error("artifact changed while creating the release snapshot");
    }
    const result = Bun.spawnSync(
      [
        "tar",
        "--uid", "0",
        "--gid", "0",
        "--uname", "root",
        "--gname", "wheel",
        "-C", work,
        "-czf", stage,
        basename(snapshot),
      ],
      {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `release archive packaging failed: ${new TextDecoder().decode(result.stderr).trim()}`,
      );
    }
    const verbose = Bun.spawnSync(["tar", "-tzvf", stage], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const listing = new TextDecoder().decode(verbose.stdout);
    if (
      verbose.exitCode !== 0 ||
      !listing.trim() ||
      listing.split("\n").filter(Boolean).some(
        (line) => !/^[d-]\S*\s+\d+\s+root\s+wheel\s+/.test(line),
      )
    ) {
      throw new Error("release archive ownership verification failed");
    }
    const extracted = join(work, "extracted");
    mkdirSync(extracted, { mode: 0o700 });
    const extraction = Bun.spawnSync(["tar", "-xzf", stage, "-C", extracted], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (
      extraction.exitCode !== 0 ||
      JSON.stringify(readdirSync(extracted)) !== JSON.stringify([basename(snapshot)])
    ) {
      throw new Error("release archive extraction verification failed");
    }
    verifyDistributionArtifact(join(extracted, basename(snapshot)));
    const packaged = { bytes: statSync(stage).size, sha256: sha256(stage) };
    // Hard-link creation fails if another process created the destination;
    // unlike rename, it never overwrites that file.
    linkSync(stage, archive);
    return { archive, ...packaged };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const artifact = argument("--artifact");
  const archive = argument("--archive");
  if (!artifact || !archive) {
    throw new Error(
      "usage: package-distribution --artifact DIR --archive FILE.tar.gz",
    );
  }
  console.log(JSON.stringify({ status: "packaged", ...packageDistribution(artifact, archive) }));
}
