// Builds from an allowlist into a new directory. It never clones or copies the
// working tree wholesale, so ignored files and private Git history cannot enter
// the product artifact and then be "cleaned up" afterward.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import {
  ARTIFACT_EXECUTABLES,
  ARTIFACT_LIFECYCLE_VALIDATION_COMMANDS,
  ARTIFACT_MANIFEST_PATH,
  WORDHOLD_ARTIFACT_FORMAT,
  WORDHOLD_MINIMUM_MACOS,
  artifactReleaseId,
  executableArchitecture,
  executableMinimumMacOS,
  verifyDistributionArtifact,
  type ArtifactManifest,
} from "../core/artifact.ts";
import { verifyQualifiedOnlineShortcut } from "./verify-online-shortcut.ts";
import {
  BUN_DARWIN_ARM64_EXECUTABLE_SHA256,
  verifyThirdPartyLicenses,
} from "./verify-third-party-licenses.ts";
export {
  artifactReleaseId,
  verifyDistributionArtifact,
  type ArtifactManifest,
} from "../core/artifact.ts";

const FILES = [
  ".gitignore",
  "AGENTS.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "bun.lock",
  "licenses/bun-1.3.11/LICENSE.md",
  "licenses/bun-1.3.11/SOURCE.md",
  "package.json",
  "papertrail.config.example.json",
  "tsconfig.json",
  "agent/enrich.ts",
  "agent/enrichment-schema.json",
  "agent/prompts/enrich.md",
  "cli/pt.ts",
  "cli/wordhold.ts",
  "integrations/hermes/papertrail/SKILL.md",
  "integrations/shortcuts/Save to Papertrail — Online.shortcut",
  "integrations/shortcuts/Papertrail.offer.json",
  "integrations/shortcuts/Papertrail.md",
  "types/text-imports.d.ts",
  "types/turndown.d.ts",
  "worker/tsconfig.json",
  "worker/wrangler.distribution.toml",
] as const;

const TREES = [
  "core",
  "daemon",
  "mcp",
  "scripts",
  "worker/migrations",
  "worker/src",
] as const;

const DOCS = [
  "docs/architecture.md",
  "docs/agents/domain.md",
  "docs/agents/issue-tracker.md",
  "docs/agents/triage-labels.md",
  "docs/how-it-works.md",
  "docs/integrations.md",
  "docs/operations.md",
  "docs/release-verification.md",
  "docs/setup.md",
  "docs/source-provenance.md",
  "docs/decisions/0001-self-hosted-single-owner.md",
] as const;

const BINARIES = [
  { entry: "cli/wordhold.ts", path: "wordhold" },
  { entry: "cli/wordhold.ts", path: "papertrail" },
  { entry: "daemon/main.ts", path: "bin/papertrail-daemon" },
  { entry: "daemon/digest.ts", path: "bin/papertrail-digest" },
  { entry: "agent/enrich.ts", path: "bin/papertrail-enrich" },
  { entry: "mcp/server.ts", path: "bin/papertrail-mcp" },
  { entry: "daemon/resurface.ts", path: "bin/papertrail-resurface" },
  { entry: "cli/pt.ts", path: "bin/pt" },
] as const;

const TEXT_EXTENSIONS = new Set([
  "",
  ".json",
  ".lock",
  ".md",
  ".sql",
  ".toml",
  ".ts",
]);

function extension(path: string): string {
  const last = path.split("/").at(-1) ?? "";
  const dot = last.lastIndexOf(".");
  return dot === -1 ? "" : last.slice(dot);
}

function copy(
  sourceRoot: string,
  outputRoot: string,
  path: string,
  target = path,
  requireHead = false,
): void {
  const source = join(sourceRoot, path);
  if (!existsSync(source) || !lstatSync(source).isFile()) {
    throw new Error(`distribution allowlist entry is missing: ${path}`);
  }
  const reviewed = requireHead ? reviewedSourceBytes(sourceRoot, path) : null;
  const destination = join(outputRoot, target);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (reviewed && !readFileSync(destination).equals(reviewed)) {
    throw new Error(`distribution source member changed while copying: ${path}`);
  }
}

function walk(root: string, relativeRoot: string): string[] {
  const absolute = join(root, relativeRoot);
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(relativeRoot, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`distribution source contains a symbolic link: ${path}`);
      }
      if (!entry.isDirectory() && !entry.isFile()) {
        throw new Error(`distribution source contains a special file: ${path}`);
      }
      return entry.isDirectory() ? walk(root, path) : [path];
    })
    .sort();
}

function trackedFiles(sourceRoot: string): Set<string> {
  // NUL framing is required for non-ASCII and otherwise quoted Git paths.
  const result = Bun.spawnSync(["git", "ls-files", "--cached", "-z", "--"], {
    cwd: sourceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error("could not determine reviewed distribution source inventory");
  }
  return new Set(
    new TextDecoder().decode(result.stdout).split("\0").filter(Boolean),
  );
}

function reviewedTreePaths(
  sourceRoot: string,
  tree: string,
  reviewed: Set<string>,
): string[] {
  const actual = walk(sourceRoot, tree);
  const expected = [...reviewed]
    .filter((path) => path.startsWith(`${tree}/`))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter((path) => !actual.includes(path));
    const untracked = actual.filter((path) => !reviewed.has(path));
    throw new Error(
      `distribution source tree differs from Git inventory${missing.length ? `; missing: ${missing.join(", ")}` : ""}${untracked.length ? `; untracked: ${untracked.join(", ")}` : ""}`,
    );
  }
  return actual;
}

export function assertReviewedDistributionTree(
  sourceRoot: string,
  tree: string,
): string[] {
  return reviewedTreePaths(sourceRoot, tree, trackedFiles(sourceRoot));
}

function reviewedSourceBytes(sourceRoot: string, path: string): Buffer {
  const source = join(sourceRoot, path);
  if (!existsSync(source) || !lstatSync(source).isFile()) {
    throw new Error(`distribution allowlist entry is missing: ${path}`);
  }
  const result = Bun.spawnSync(["git", "show", `HEAD:${path}`], {
    cwd: sourceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`distribution source member is not committed at HEAD: ${path}`);
  }
  const reviewed = Buffer.from(result.stdout);
  if (!readFileSync(source).equals(reviewed)) {
    throw new Error(`distribution source member differs from HEAD: ${path}`);
  }
  return reviewed;
}

export function assertReviewedDistributionSources(
  sourceRoot: string,
  paths: readonly string[],
): void {
  const reviewed = trackedFiles(sourceRoot);
  for (const path of paths) {
    if (!reviewed.has(path)) {
      throw new Error(`distribution source member is not Git-tracked: ${path}`);
    }
    reviewedSourceBytes(sourceRoot, path);
  }
}

function canonicalMissingTarget(path: string): string {
  let ancestor = path;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    missing.unshift(ancestor.split("/").at(-1)!);
    ancestor = dirname(ancestor);
  }
  return resolve(realpathSync(ancestor), ...missing);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceIdentity(sourceRoot: string): ArtifactManifest["source"] {
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: sourceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (revision.exitCode !== 0) {
    throw new Error("distribution source must be a Git working tree with a completed revision");
  }
  const status = Bun.spawnSync(
    ["git", "status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: sourceRoot, stdout: "pipe", stderr: "pipe" },
  );
  if (status.exitCode !== 0) {
    throw new Error("could not determine distribution source dirty state");
  }
  return {
    revision: new TextDecoder().decode(revision.stdout).trim(),
    dirty: new TextDecoder().decode(status.stdout).trim().length > 0,
  };
}

function isolatedBuildEnvironment(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const name of [
    "BUN_OPTIONS",
    "NODE_OPTIONS",
    "NODE_PATH",
  ]) {
    delete env[name];
  }
  return env;
}

function runBuild(sourceRoot: string, entry: string, output: string): void {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--reject-unresolved",
      entry,
      "--outfile",
      output,
    ],
    { cwd: sourceRoot, env: isolatedBuildEnvironment() },
  );
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
}

function installFrozenReleaseDependencies(outputRoot: string): string {
  const dependencyTree = join(outputRoot, "node_modules");
  if (existsSync(dependencyTree)) {
    throw new Error("release dependency destination must start absent");
  }
  const packagePath = join(outputRoot, "package.json");
  const lockPath = join(outputRoot, "bun.lock");
  const packageBytes = readFileSync(packagePath);
  const lockBytes = readFileSync(lockPath);
  const result = Bun.spawnSync([
    process.execPath,
    "install",
    "--production",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--no-save",
    "--backend=copyfile",
    "--no-progress",
    "--no-summary",
  ], {
    cwd: outputRoot,
    env: isolatedBuildEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `isolated frozen dependency install failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  if (
    !existsSync(dependencyTree) ||
    !lstatSync(dependencyTree).isDirectory() ||
    !readFileSync(packagePath).equals(packageBytes) ||
    !readFileSync(lockPath).equals(lockBytes)
  ) {
    throw new Error("isolated frozen dependency install changed reviewed build inputs");
  }
  return dependencyTree;
}

function signExecutable(path: string): void {
  if (process.platform !== "darwin") {
    throw new Error("Wordhold distribution builds currently require macOS");
  }
  const signed = Bun.spawnSync(
    ["codesign", "--force", "--sign", "-", "--timestamp=none", path],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (signed.exitCode !== 0) {
    throw new Error(`ad-hoc signing failed: ${new TextDecoder().decode(signed.stderr).trim()}`);
  }
  const verified = Bun.spawnSync(["codesign", "--verify", "--strict", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (verified.exitCode !== 0) {
    throw new Error(
      `ad-hoc signature verification failed: ${new TextDecoder().decode(verified.stderr).trim()}`,
    );
  }
}

function directPackageVersions(
  sourceRoot: string,
  dependencies: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.keys(dependencies).sort().map((name) => {
      const metadata = JSON.parse(
        readFileSync(join(sourceRoot, "node_modules", name, "package.json"), "utf8"),
      ) as { version?: unknown };
      if (typeof metadata.version !== "string" || !metadata.version) {
        throw new Error(`installed dependency version is missing: ${name}`);
      }
      return [name, metadata.version];
    }),
  );
}

function privacyScan(outputRoot: string, sourceRoot: string): void {
  const forbidden = [
    /\/Users\//i,
    /pt_[a-z0-9]{10}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  const compilerBytes = readFileSync(process.execPath);
  const hostHome = homedir();
  for (const path of walk(outputRoot, ".")) {
    const normalized = relative(outputRoot, join(outputRoot, path));
    if (normalized.endsWith(".shortcut")) {
      const bytes = readFileSync(join(outputRoot, path));
      for (const marker of [
        sourceRoot,
        homedir(),
        "/Users/",
        "workers.dev",
        "Authorization",
        "Bearer ",
      ]) {
        if (bytes.includes(Buffer.from(marker))) {
          throw new Error(`distribution Shortcut privacy scan rejected ${normalized}`);
        }
      }
      continue;
    }
    if ((ARTIFACT_EXECUTABLES as readonly string[]).includes(normalized)) {
      const bytes = readFileSync(join(outputRoot, path));
      if (bytes.includes(Buffer.from(sourceRoot))) {
        throw new Error(`distribution binary privacy scan rejected ${normalized}`);
      }
      // Compiled executables contain the pinned Bun runtime. Its own upstream
      // build paths are harmless baseline bytes (including the GitHub Actions
      // runner home); only additional host-home occurrences indicate that
      // Wordhold embedded recipient/build-machine state.
      if (
        hasAdditionalMarkerOccurrences(bytes, compilerBytes, hostHome)
      ) {
        throw new Error(`distribution binary privacy scan rejected ${normalized}`);
      }
      continue;
    }
    if (!TEXT_EXTENSIONS.has(extension(normalized))) continue;
    const text = readFileSync(join(outputRoot, path), "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(text)) {
        throw new Error(`distribution privacy scan rejected ${normalized}: ${pattern}`);
      }
    }
  }
}

export function hasAdditionalMarkerOccurrences(
  bytes: Uint8Array,
  baseline: Uint8Array,
  marker: string,
): boolean {
  return countOccurrences(bytes, marker) > countOccurrences(baseline, marker);
}

function countOccurrences(bytes: Uint8Array, marker: string): number {
  const haystack = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const needle = Buffer.from(marker);
  if (!needle.length) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

export function buildDistribution(
  sourceRoot: string,
  rawOutput: string,
  options: { release?: boolean } = {},
): string {
  sourceRoot = realpathSync(sourceRoot);
  const outputRoot = canonicalMissingTarget(isAbsolute(rawOutput) ? rawOutput : resolve(rawOutput));
  if (pathsOverlap(sourceRoot, outputRoot)) {
    throw new Error("distribution source and output must not overlap");
  }
  if (existsSync(outputRoot)) {
    throw new Error(`distribution output already exists: ${outputRoot}`);
  }
  if (
    options.release === true &&
    (
      process.platform !== "darwin" ||
      process.arch !== "arm64" ||
      sha256(readFileSync(process.execPath)) !== BUN_DARWIN_ARM64_EXECUTABLE_SHA256
    )
  ) {
    throw new Error(
      "release build requires the pinned official Bun 1.3.11 darwin/arm64 compiler",
    );
  }
  mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
  try {
    const reviewed = trackedFiles(sourceRoot);
    for (const path of [...FILES, ...DOCS, "worker/wrangler.distribution.toml"]) {
      if (!reviewed.has(path)) {
        throw new Error(`distribution source member is not Git-tracked: ${path}`);
      }
    }
    for (const path of [...FILES, ...DOCS]) {
      copy(sourceRoot, outputRoot, path, path, options.release === true);
    }
    copy(
      sourceRoot,
      outputRoot,
      "worker/wrangler.distribution.toml",
      "worker/wrangler.toml",
      options.release === true,
    );
    for (const tree of TREES) {
      for (const path of reviewedTreePaths(sourceRoot, tree, reviewed)) {
        // Release-construction and source-boundary audit tools belong in the
        // source repository, not in the recipient runtime artifact.
        if (
          path === "scripts/build-distribution.ts" ||
          path === "scripts/package-distribution.ts" ||
          path === "scripts/release-candidate.ts" ||
          path === "scripts/verify-release-download.ts" ||
          path === "scripts/verify-source-boundary.ts" ||
          path === "scripts/verify-online-shortcut.ts" ||
          path === "scripts/verify-third-party-licenses.ts"
        ) {
          continue;
        }
        if (!reviewed.has(path)) {
          throw new Error(`distribution source member is not Git-tracked: ${path}`);
        }
        copy(sourceRoot, outputRoot, path, path, options.release === true);
      }
    }

    // The signed Shortcut is opaque to ordinary byte scans. Verify the exact
    // reviewed copy that will ship, not a mutable source path beside it.
    verifyQualifiedOnlineShortcut(outputRoot);

    const packageJson = JSON.parse(
      readFileSync(join(outputRoot, "package.json"), "utf8"),
    ) as { version?: unknown; dependencies?: Record<string, string> };
    if (typeof packageJson.version !== "string" || !packageJson.version) {
      throw new Error("distribution package version is missing");
    }

    // Development builds may reuse the workspace install for speed. Release
    // builds instead install the committed lockfile into this new build root;
    // the copyfile backend prevents later cache mutation from changing inputs.
    const dependencyTree = join(outputRoot, "node_modules");
    if (options.release === true) {
      installFrozenReleaseDependencies(outputRoot);
    } else {
      const ambientDependencies = join(sourceRoot, "node_modules");
      if (
        !existsSync(ambientDependencies) ||
        !lstatSync(ambientDependencies).isDirectory()
      ) {
        throw new Error("distribution build requires source node_modules; run bun install first");
      }
      cpSync(ambientDependencies, dependencyTree, { recursive: true });
    }
    let directPackages: Record<string, string>;
    let minimumMacOS: string;
    try {
      // Verify notices against the exact dependency tree that supplies the
      // compiled binaries. Release builds create this tree from the committed
      // lockfile in isolation; development builds use the equivalent logical
      // production closure inside the copied workspace install.
      verifyThirdPartyLicenses({
        sourceRoot: outputRoot,
        nodeModules: dependencyTree,
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
      });
      mkdirSync(join(outputRoot, "bin"), { recursive: true });
      for (const binary of BINARIES) {
        runBuild(outputRoot, binary.entry, join(outputRoot, binary.path));
        signExecutable(join(outputRoot, binary.path));
      }
      const deploymentTargets = new Set(
        BINARIES.map((binary) => executableMinimumMacOS(join(outputRoot, binary.path))),
      );
      if (
        deploymentTargets.size !== 1 ||
        !deploymentTargets.has(WORDHOLD_MINIMUM_MACOS)
      ) {
        throw new Error(
          `compiled executables must all target macOS ${WORDHOLD_MINIMUM_MACOS}`,
        );
      }
      const expectedArchitecture = process.arch === "x64" ? "x86_64" : process.arch;
      const architectures = new Set(
        BINARIES.map((binary) => executableArchitecture(join(outputRoot, binary.path))),
      );
      if (architectures.size !== 1 || !architectures.has(expectedArchitecture)) {
        throw new Error(
          `compiled executables must all contain only ${expectedArchitecture}`,
        );
      }
      minimumMacOS = WORDHOLD_MINIMUM_MACOS;
      directPackages = directPackageVersions(
        outputRoot,
        packageJson.dependencies ?? {},
      );
    } finally {
      rmSync(dependencyTree, { recursive: true, force: true });
    }
    privacyScan(outputRoot, sourceRoot);

    const files = walk(outputRoot, ".")
      .map((path) => relative(outputRoot, join(outputRoot, path)))
      .filter((path) => path !== ARTIFACT_MANIFEST_PATH)
      .sort();
    const base = {
      format: WORDHOLD_ARTIFACT_FORMAT,
      product: "papertrail" as const,
      version: packageJson.version,
      source: sourceIdentity(sourceRoot),
      build: {
        platform: process.platform,
        arch: process.arch,
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
        bunExecutableSha256: sha256(readFileSync(process.execPath)),
        minimumMacOS,
        compileAutoload: { dotenv: false, bunfig: false },
        dependencyInstall: options.release === true
          ? "frozen-production-isolated" as const
          : "ambient-development" as const,
        packageJsonSha256: sha256(readFileSync(join(outputRoot, "package.json"))),
        bunLockSha256: sha256(readFileSync(join(outputRoot, "bun.lock"))),
      },
      executables: [...ARTIFACT_EXECUTABLES],
      runtime: {
        externalCommands: ["git"],
        lifecycleValidationCommands: [...ARTIFACT_LIFECYCLE_VALIDATION_COMMANDS],
        bundledRuntime: {
          name: "bun" as const,
          version: Bun.version,
          revision: Bun.revision,
        },
        directPackages,
      },
      signing: { kind: "adhoc" as const, verified: true as const },
      files: Object.fromEntries(
        files.map((path) => [path, sha256(readFileSync(join(outputRoot, path)))]),
      ),
    };
    const manifest: ArtifactManifest = {
      ...base,
      releaseId: artifactReleaseId(base),
    };
    writeFileSync(
      join(outputRoot, ARTIFACT_MANIFEST_PATH),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600 },
    );
    verifyDistributionArtifact(outputRoot);
    return outputRoot;
  } catch (error) {
    rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const index = process.argv.indexOf("--output");
  const output = index === -1 ? undefined : process.argv[index + 1];
  if (!output) throw new Error("usage: build-distribution --output <new-directory>");
  const sourceRoot = dirname(import.meta.dir);
  const built = buildDistribution(sourceRoot, output);
  const { manifest } = verifyDistributionArtifact(built);
  console.log(JSON.stringify({
    status: "built",
    output: built,
    version: manifest.version,
    releaseId: manifest.releaseId,
    source: manifest.source,
    target: manifest.build,
  }));
}
