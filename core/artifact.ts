import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export const ARTIFACT_EXECUTABLES = [
  "wordhold",
  "papertrail",
  "bin/papertrail-daemon",
  "bin/papertrail-digest",
  "bin/papertrail-enrich",
  "bin/papertrail-mcp",
  "bin/papertrail-resurface",
  "bin/pt",
] as const;

const PAPERTRAIL_ARTIFACT_EXECUTABLES = ARTIFACT_EXECUTABLES.filter(
  (path) => path !== "wordhold",
);

const LEGACY_ARTIFACT_EXECUTABLES = PAPERTRAIL_ARTIFACT_EXECUTABLES.filter(
  (path) => path !== "papertrail",
);

export const ARTIFACT_MANIFEST_PATH = ".papertrail-artifact.json";
export const WORDHOLD_ARTIFACT_FORMAT = 5 as const;
export const WORDHOLD_MINIMUM_MACOS = "13.0";

// The manifest filename and product discriminator are durable pre-0.5
// lifecycle identifiers. Format 4 adds the Wordhold entrypoint while keeping
// old release directories verifiable for in-place update and uninstall.

export interface ArtifactManifest {
  format: 2 | 3 | 4 | 5;
  product: "papertrail";
  version: string;
  source: { revision: string; dirty: boolean };
  build: {
    platform: string;
    arch: string;
    bunVersion: string;
    bunRevision?: string;
    bunExecutableSha256?: string;
    minimumMacOS?: string;
    compileAutoload?: { dotenv: boolean; bunfig: boolean };
    dependencyInstall?: "ambient-development" | "frozen-production-isolated";
    packageJsonSha256?: string;
    bunLockSha256?: string;
  };
  executables: string[];
  files: Record<string, string>;
  runtime?: {
    externalCommands: string[];
    bundledRuntime: { name: "bun"; version: string; revision?: string };
    directPackages: Record<string, string>;
  };
  signing?: { kind: "adhoc"; verified: true };
  releaseId: string;
}

export interface VerifiedArtifact {
  manifest: ArtifactManifest;
  raw: string;
}

export interface ArtifactHost {
  platform: string;
  arch: string;
  macOSVersion?: string;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function orderedFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** Stable content identity. Deliberately excludes timestamps and releaseId. */
export function artifactReleaseId(
  manifest: Omit<ArtifactManifest, "releaseId"> | ArtifactManifest,
): string {
  const identity = {
    format: manifest.format,
    product: manifest.product,
    version: manifest.version,
    source: manifest.source,
    build: manifest.build,
    executables: [...manifest.executables].sort(),
    files: orderedFiles(manifest.files),
    ...(manifest.format >= 3
      ? { runtime: manifest.runtime, signing: manifest.signing }
      : {}),
  };
  return sha256(JSON.stringify(identity));
}

function safeRelative(path: string): boolean {
  return path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function privateMember(path: string): boolean {
  const parts = path.split("/");
  const first = parts[0];
  const name = parts.at(-1) ?? path;
  return first === ".git" ||
    parts.includes(".scratch") ||
    parts.includes(".wrangler") ||
    first === "items" ||
    first === "inbox" ||
    first === "logs" ||
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".dev.vars" ||
    name.startsWith(".dev.vars.") ||
    path === "papertrail.config.json" ||
    path === "wordhold.config.json" ||
    /^(?:papertrail|wordhold)\.db(?:-|$)/.test(path);
}

interface Inventory {
  files: string[];
  directories: string[];
}

function inventory(root: string, relativeRoot = ""): Inventory {
  const files: string[] = [];
  const directories: string[] = [];
  const absolute = relativeRoot ? join(root, relativeRoot) : root;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = relativeRoot ? join(relativeRoot, entry.name) : entry.name;
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(`artifact contains symbolic link: ${path}`);
    if (stat.isDirectory()) {
      directories.push(path);
      const nested = inventory(root, path);
      files.push(...nested.files);
      directories.push(...nested.directories);
    } else if (stat.isFile()) {
      files.push(path);
    } else {
      throw new Error(`artifact contains special file: ${path}`);
    }
  }
  return { files: files.sort(), directories: directories.sort() };
}

function expectedDirectories(files: string[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    let parent = dirname(file);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  return [...directories].sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function manifestShape(value: unknown): ArtifactManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Wordhold artifact manifest");
  }
  const manifest = value as Partial<ArtifactManifest>;
  if (
    (manifest.format !== 2 && manifest.format !== 3 && manifest.format !== 4 &&
      manifest.format !== WORDHOLD_ARTIFACT_FORMAT) ||
    manifest.product !== "papertrail" ||
    typeof manifest.version !== "string" ||
    manifest.version.length === 0 ||
    !manifest.source ||
    typeof manifest.source.revision !== "string" ||
    !/^[0-9a-f]{40}$/.test(manifest.source.revision) ||
    typeof manifest.source.dirty !== "boolean" ||
    !manifest.build ||
    typeof manifest.build.platform !== "string" ||
    typeof manifest.build.arch !== "string" ||
    typeof manifest.build.bunVersion !== "string" ||
    !Array.isArray(manifest.executables) ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files) ||
    typeof manifest.releaseId !== "string"
  ) {
    throw new Error("invalid Wordhold artifact manifest");
  }
  if (
    manifest.format >= 3 &&
    (
      !manifest.runtime ||
      JSON.stringify(manifest.runtime.externalCommands) !== JSON.stringify(["git"]) ||
      manifest.runtime.bundledRuntime?.name !== "bun" ||
      typeof manifest.runtime.bundledRuntime.version !== "string" ||
      manifest.runtime.bundledRuntime.version !== manifest.build.bunVersion ||
      !manifest.runtime.directPackages ||
      Array.isArray(manifest.runtime.directPackages) ||
      Object.values(manifest.runtime.directPackages).some(
        (version) => typeof version !== "string" || version.length === 0,
      ) ||
      manifest.signing?.kind !== "adhoc" ||
      manifest.signing.verified !== true
    )
  ) {
    throw new Error("invalid Wordhold artifact runtime metadata");
  }
  if (
    manifest.format >= WORDHOLD_ARTIFACT_FORMAT &&
    (
      !/^[0-9a-f]{40}$/.test(manifest.build.bunRevision ?? "") ||
      !/^[0-9a-f]{64}$/.test(manifest.build.bunExecutableSha256 ?? "") ||
      manifest.runtime?.bundledRuntime.revision !== manifest.build.bunRevision ||
      manifest.build.minimumMacOS !== WORDHOLD_MINIMUM_MACOS ||
      manifest.build.compileAutoload?.dotenv !== false ||
      manifest.build.compileAutoload?.bunfig !== false ||
      (manifest.build.dependencyInstall !== "ambient-development" &&
        manifest.build.dependencyInstall !== "frozen-production-isolated") ||
      !/^[0-9a-f]{64}$/.test(manifest.build.packageJsonSha256 ?? "") ||
      !/^[0-9a-f]{64}$/.test(manifest.build.bunLockSha256 ?? "") ||
      manifest.build.packageJsonSha256 !== manifest.files?.["package.json"] ||
      manifest.build.bunLockSha256 !== manifest.files?.["bun.lock"]
    )
  ) {
    throw new Error("invalid Wordhold artifact build provenance");
  }
  return manifest as ArtifactManifest;
}

function numericVersion(value: string): number[] | null {
  if (!/^\d+(?:\.\d+)*$/.test(value)) return null;
  return value.split(".").map(Number);
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = numericVersion(actual);
  const right = numericVersion(minimum);
  if (!left || !right) return false;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function currentMacOSVersion(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const result = Bun.spawnSync(["/usr/bin/sw_vers", "-productVersion"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return undefined;
  const version = new TextDecoder().decode(result.stdout).trim();
  return numericVersion(version) ? version : undefined;
}

/** Read the Mach-O deployment floor rather than trusting manifest metadata. */
export function executableMinimumMacOS(path: string): string {
  const result = Bun.spawnSync(["/usr/bin/otool", "-l", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`could not inspect executable deployment target: ${path}`);
  }
  const values = [...new TextDecoder().decode(result.stdout).matchAll(
    /^\s*minos\s+(\d+(?:\.\d+)*)\s*$/gm,
  )].map((match) => match[1]!);
  if (values.length !== 1) {
    throw new Error(`executable has an ambiguous macOS deployment target: ${path}`);
  }
  return values[0]!;
}

/** Read the actual thin Mach-O architecture rather than trusting metadata. */
export function executableArchitecture(path: string): string {
  const result = Bun.spawnSync(["/usr/bin/lipo", "-archs", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`could not inspect executable architecture: ${path}`);
  }
  const architectures = new TextDecoder().decode(result.stdout).trim()
    .split(/\s+/)
    .filter(Boolean);
  if (architectures.length !== 1) {
    throw new Error(`executable must contain exactly one architecture: ${path}`);
  }
  return architectures[0]!;
}

/** Require a runnable Mach-O image, not merely an executable-mode Mach-O file. */
export function executableMachOType(path: string): string {
  const result = Bun.spawnSync(["/usr/bin/otool", "-hv", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`could not inspect executable Mach-O type: ${path}`);
  }
  const match = /^\s*MH_MAGIC(?:_64)?\s+\S+\s+\S+\s+\S+\s+(\S+)\s+/m.exec(
    new TextDecoder().decode(result.stdout),
  );
  if (!match) throw new Error(`could not parse executable Mach-O type: ${path}`);
  return match[1]!;
}

function machoArchitecture(nodeArchitecture: string): string {
  return nodeArchitecture === "x64" ? "x86_64" : nodeArchitecture;
}

/**
 * Verify the complete release boundary before lifecycle code copies or mutates
 * anything. The adjacent manifest provides integrity; handoff authenticity is
 * a separate operator concern.
 */
export function verifyDistributionArtifact(
  root: string,
  host: ArtifactHost = {
    platform: process.platform,
    arch: process.arch,
    macOSVersion: currentMacOSVersion(),
  },
): VerifiedArtifact {
  const manifestPath = join(root, ARTIFACT_MANIFEST_PATH);
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) {
    throw new Error("source is not a Wordhold distribution artifact");
  }
  const raw = readFileSync(manifestPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid Wordhold artifact manifest");
  }
  const manifest = manifestShape(parsed);
  if (manifest.releaseId !== artifactReleaseId(manifest)) {
    throw new Error("artifact release id mismatch");
  }
  if (manifest.build.platform !== host.platform || manifest.build.arch !== host.arch) {
    throw new Error(
      `incompatible artifact target ${manifest.build.platform}/${manifest.build.arch}; current host is ${host.platform}/${host.arch}`,
    );
  }
  if (manifest.format >= WORDHOLD_ARTIFACT_FORMAT) {
    const hostVersion = host.macOSVersion ?? currentMacOSVersion();
    if (
      host.platform !== "darwin" ||
      !hostVersion ||
      !versionAtLeast(hostVersion, manifest.build.minimumMacOS!)
    ) {
      throw new Error(
        `incompatible macOS version ${hostVersion ?? "unknown"}; Wordhold requires ${manifest.build.minimumMacOS} or newer`,
      );
    }
  }

  const declared = Object.keys(manifest.files).sort();
  if (manifest.format >= WORDHOLD_ARTIFACT_FORMAT) {
    for (const required of [
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
      "licenses/bun-1.3.11/LICENSE.md",
      "licenses/bun-1.3.11/SOURCE.md",
    ]) {
      if (!manifest.files[required]) {
        throw new Error(`artifact is missing required legal/provenance member: ${required}`);
      }
    }
  }
  for (const path of declared) {
    if (!safeRelative(path) || path === ARTIFACT_MANIFEST_PATH) {
      throw new Error(`artifact contains unsafe member: ${path}`);
    }
    if (privateMember(path)) throw new Error(`artifact contains private member: ${path}`);
    if (!/^[0-9a-f]{64}$/.test(manifest.files[path]!)) {
      throw new Error(`artifact contains invalid hash: ${path}`);
    }
  }
  const contents = inventory(root);
  const actual = contents.files.filter((path) => path !== ARTIFACT_MANIFEST_PATH);
  const unexpected = actual.filter((path) => !manifest.files[path]);
  const missing = declared.filter((path) => !actual.includes(path));
  if (unexpected.length || missing.length) {
    throw new Error(
      `artifact inventory mismatch${unexpected.length ? `; unlisted: ${unexpected.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`,
    );
  }
  const directories = expectedDirectories([...declared, ARTIFACT_MANIFEST_PATH]);
  if (!sameStrings(contents.directories, directories)) {
    const extra = contents.directories.filter((path) => !directories.includes(path));
    const absent = directories.filter((path) => !contents.directories.includes(path));
    throw new Error(
      `artifact directory inventory mismatch${extra.length ? `; unlisted: ${extra.join(", ")}` : ""}${absent.length ? `; missing: ${absent.join(", ")}` : ""}`,
    );
  }
  for (const path of declared) {
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    if (!stat.isFile()) throw new Error(`artifact member is not a regular file: ${path}`);
    if (sha256(readFileSync(absolute)) !== manifest.files[path]) {
      throw new Error(`artifact hash mismatch: ${path}`);
    }
  }

  const executables = [...manifest.executables].sort();
  const expectedExecutables = manifest.format === 2
    ? [...LEGACY_ARTIFACT_EXECUTABLES].sort()
    : manifest.format === 3
    ? [...PAPERTRAIL_ARTIFACT_EXECUTABLES].sort()
    : [...ARTIFACT_EXECUTABLES].sort();
  if (!sameStrings(executables, expectedExecutables)) {
    throw new Error("artifact executable inventory mismatch");
  }
  for (const path of executables) {
    if (!manifest.files[path]) throw new Error(`artifact executable is undeclared: ${path}`);
    if ((lstatSync(join(root, path)).mode & 0o111) === 0) {
      throw new Error(`artifact member is not executable: ${path}`);
    }
    if (
      manifest.format >= WORDHOLD_ARTIFACT_FORMAT &&
      executableMinimumMacOS(join(root, path)) !== manifest.build.minimumMacOS
    ) {
      throw new Error(`artifact executable deployment target mismatch: ${path}`);
    }
    if (
      manifest.format >= WORDHOLD_ARTIFACT_FORMAT &&
      executableArchitecture(join(root, path)) !== machoArchitecture(manifest.build.arch)
    ) {
      throw new Error(`artifact executable architecture mismatch: ${path}`);
    }
    if (
      manifest.format >= WORDHOLD_ARTIFACT_FORMAT &&
      executableMachOType(join(root, path)) !== "EXECUTE"
    ) {
      throw new Error(`artifact member is not a Mach-O executable: ${path}`);
    }
  }
  return { manifest, raw };
}
