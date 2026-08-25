import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const BUN_RUNTIME_VERSION = "1.3.11";
export const BUN_RUNTIME_REVISION =
  "af24e281ebacd6ac77c0f14b4206599cf4ae1c9f";
export const BUN_DARWIN_ARM64_EXECUTABLE_SHA256 =
  "1d77af7bfd811aebb7d37bec496a5eed14fe227ded3ab7866d2f39786e8107b6";
const APACHE_LICENSE_SHA256 =
  "8c6db340475136df3c1201d458fa5755698eace76e510471ecc9d857d6083dac";
const WORDHOLD_NOTICE_SHA256 =
  "0a2806ced1504561c868280098988e080f0274bd3beb5f2f97034343150a3d0b";
const BUN_LICENSE_SHA256 =
  "4e742b51000ef3904d9923e2a06a696136ff8f957856cef83076ea3b577f313d";
const BUN_SOURCE_NOTICE_SHA256 =
  "73e2152107fdd45f4a6b26e4b266835876537cdbc1b2fca32d3882124b0ab449";

const ALLOWED_LICENSES = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "MIT-0",
]);

interface PackageNotice {
  name: string;
  version: string;
  license: string;
  files: Array<{ name: string; contents: string }>;
}

function packageDirectories(nodeModules: string): string[] {
  if (!existsSync(nodeModules) || !lstatSync(nodeModules).isDirectory()) {
    throw new Error("production node_modules directory is missing");
  }
  const result: string[] = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(nodeModules, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`production dependency is a symbolic link: ${entry.name}`);
    }
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(path, { withFileTypes: true })) {
        if (scoped.isSymbolicLink()) {
          throw new Error(
            `production dependency is a symbolic link: ${entry.name}/${scoped.name}`,
          );
        }
        if (scoped.isDirectory()) result.push(join(path, scoped.name));
      }
    } else {
      result.push(path);
    }
  }
  return result.sort();
}

function licenseFileNames(packageRoot: string): string[] {
  return readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) =>
      entry.isFile() &&
      /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function installedPackageNotices(nodeModules: string): PackageNotice[] {
  const byIdentity = new Map<string, PackageNotice>();
  const visit = (current: string): void => {
    for (const packageRoot of packageDirectories(current)) {
      const metadataPath = join(packageRoot, "package.json");
      if (!existsSync(metadataPath) || !lstatSync(metadataPath).isFile()) {
        throw new Error(`production dependency metadata is missing: ${packageRoot}`);
      }
      let metadata: unknown;
      try {
        metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      } catch {
        throw new Error(`production dependency metadata is invalid: ${packageRoot}`);
      }
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new Error(`production dependency metadata is invalid: ${packageRoot}`);
      }
      const value = metadata as {
        name?: unknown;
        version?: unknown;
        license?: unknown;
      };
      if (
        typeof value.name !== "string" || !value.name ||
        typeof value.version !== "string" || !value.version ||
        typeof value.license !== "string" || !value.license
      ) {
        throw new Error(`production dependency identity or license is missing: ${packageRoot}`);
      }
      if (!ALLOWED_LICENSES.has(value.license)) {
        throw new Error(
          `production dependency requires license review: ${value.name}@${value.version} (${value.license})`,
        );
      }
      const names = licenseFileNames(packageRoot);
      if (!names.length) {
        throw new Error(
          `production dependency license notice is missing: ${value.name}@${value.version}`,
        );
      }
      const notice: PackageNotice = {
        name: value.name,
        version: value.version,
        license: value.license,
        files: names.map((name) => ({
          name,
          contents: readFileSync(join(packageRoot, name), "utf8"),
        })),
      };
      const identity = `${notice.name}@${notice.version}`;
      const previous = byIdentity.get(identity);
      if (previous && JSON.stringify(previous) !== JSON.stringify(notice)) {
        throw new Error(`conflicting license notices for production dependency: ${identity}`);
      }
      byIdentity.set(identity, notice);
      const nested = join(packageRoot, "node_modules");
      if (existsSync(nested)) visit(nested);
    }
  };
  visit(realpathSync(resolve(nodeModules)));
  return [...byIdentity.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
  );
}

function resolveDependency(
  nodeModules: string,
  fromPackage: string,
  name: string,
): string | null {
  const boundary = dirname(realpathSync(resolve(nodeModules)));
  let cursor = realpathSync(resolve(fromPackage));
  while (cursor === boundary || cursor.startsWith(`${boundary}/`)) {
    const candidate = join(cursor, "node_modules", ...name.split("/"));
    if (
      existsSync(join(candidate, "package.json")) &&
      lstatSync(join(candidate, "package.json")).isFile()
    ) {
      return realpathSync(candidate);
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const topLevel = join(realpathSync(resolve(nodeModules)), ...name.split("/"));
  return existsSync(join(topLevel, "package.json")) ? realpathSync(topLevel) : null;
}

function productionPackageNotices(
  nodeModules: string,
  dependencies: Record<string, string>,
): PackageNotice[] {
  const byIdentity = new Map<string, PackageNotice>();
  const visited = new Set<string>();
  const visit = (name: string, fromPackage: string, optional = false): void => {
    const packageRoot = resolveDependency(nodeModules, fromPackage, name);
    if (!packageRoot) {
      if (optional) return;
      throw new Error(`locked production dependency is not installed: ${name}`);
    }
    if (visited.has(packageRoot)) return;
    visited.add(packageRoot);
    const metadataPath = join(packageRoot, "package.json");
    let metadata: unknown;
    try {
      metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    } catch {
      throw new Error(`production dependency metadata is invalid: ${packageRoot}`);
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error(`production dependency metadata is invalid: ${packageRoot}`);
    }
    const value = metadata as {
      name?: unknown;
      version?: unknown;
      license?: unknown;
      dependencies?: unknown;
      optionalDependencies?: unknown;
    };
    if (
      value.name !== name ||
      typeof value.version !== "string" || !value.version ||
      typeof value.license !== "string" || !value.license
    ) {
      throw new Error(`production dependency identity or license is missing: ${packageRoot}`);
    }
    if (!ALLOWED_LICENSES.has(value.license)) {
      throw new Error(
        `production dependency requires license review: ${name}@${value.version} (${value.license})`,
      );
    }
    const names = licenseFileNames(packageRoot);
    if (!names.length) {
      throw new Error(
        `production dependency license notice is missing: ${name}@${value.version}`,
      );
    }
    const notice: PackageNotice = {
      name,
      version: value.version,
      license: value.license,
      files: names.map((file) => ({
        name: file,
        contents: readFileSync(join(packageRoot, file), "utf8"),
      })),
    };
    const identity = `${name}@${value.version}`;
    const previous = byIdentity.get(identity);
    if (previous && JSON.stringify(previous) !== JSON.stringify(notice)) {
      throw new Error(`conflicting license notices for production dependency: ${identity}`);
    }
    byIdentity.set(identity, notice);
    const required = value.dependencies && typeof value.dependencies === "object" &&
        !Array.isArray(value.dependencies)
      ? Object.keys(value.dependencies as Record<string, unknown>)
      : [];
    const optionalNames = value.optionalDependencies &&
        typeof value.optionalDependencies === "object" &&
        !Array.isArray(value.optionalDependencies)
      ? Object.keys(value.optionalDependencies as Record<string, unknown>)
      : [];
    for (const child of required.sort()) visit(child, packageRoot);
    for (const child of optionalNames.sort()) visit(child, packageRoot, true);
  };
  const virtualRoot = dirname(realpathSync(resolve(nodeModules)));
  for (const name of Object.keys(dependencies).sort()) visit(name, virtualRoot);
  return [...byIdentity.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
  );
}

function fence(contents: string): string {
  const longest = Math.max(
    2,
    ...[...contents.matchAll(/`+/g)].map((match) => match[0].length),
  );
  return "`".repeat(longest + 1);
}

/** Deterministic, complete notices for the packages installed for production. */
export function generateThirdPartyNotices(
  nodeModules: string,
  dependencies?: Record<string, string>,
): string {
  const packages = dependencies
    ? productionPackageNotices(nodeModules, dependencies)
    : installedPackageNotices(nodeModules);
  const sections = packages.map((dependency) => {
    const files = dependency.files.map((file) => {
      const delimiter = fence(file.contents);
      return [
        `License file: \`${file.name}\``,
        "",
        `${delimiter}text`,
        file.contents.replace(/\n$/, ""),
        delimiter,
      ].join("\n");
    }).join("\n\n");
    return [
      `## ${dependency.name}@${dependency.version} — ${dependency.license}`,
      "",
      files,
    ].join("\n");
  });
  return [
    "# Third-party notices",
    "",
    "Generated from Wordhold's locked production dependency installation.",
    "Do not edit this file by hand; run `bun run licenses:generate`.",
    "The Bun runtime embedded in compiled executables is documented separately under `licenses/bun-1.3.11/`.",
    "",
    ...sections,
    "",
  ].join("\n");
}

export function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function verifyThirdPartyNotices(
  noticePath: string,
  nodeModules: string,
  dependencies?: Record<string, string>,
): number {
  if (!existsSync(noticePath) || !lstatSync(noticePath).isFile()) {
    throw new Error("third-party notices are missing, stale, or mismatched");
  }
  const expected = generateThirdPartyNotices(nodeModules, dependencies);
  if (readFileSync(noticePath, "utf8") !== expected) {
    throw new Error("third-party notices are missing, stale, or mismatched");
  }
  return dependencies
    ? productionPackageNotices(nodeModules, dependencies).length
    : installedPackageNotices(nodeModules).length;
}

function requireFileDigest(path: string, digest: string, label: string): void {
  if (
    !existsSync(path) ||
    lstatSync(path).isSymbolicLink() ||
    !lstatSync(path).isFile() ||
    sha256(readFileSync(path)) !== digest
  ) {
    throw new Error(`${label} is missing or differs from its reviewed bytes`);
  }
}

export function verifyThirdPartyLicenses(options: {
  sourceRoot: string;
  nodeModules: string;
  bunVersion: string;
  bunRevision: string;
}): { bunVersion: string; bunRevision: string; packages: number } {
  const sourceRoot = realpathSync(resolve(options.sourceRoot));
  if (options.bunVersion !== BUN_RUNTIME_VERSION) {
    throw new Error(
      `Bun runtime license set covers ${BUN_RUNTIME_VERSION}, not ${options.bunVersion}`,
    );
  }
  if (options.bunRevision !== BUN_RUNTIME_REVISION) {
    throw new Error(
      `Bun runtime source notice covers ${BUN_RUNTIME_REVISION}, not ${options.bunRevision}`,
    );
  }
  const packageJson = JSON.parse(
    readFileSync(join(sourceRoot, "package.json"), "utf8"),
  ) as { license?: unknown; dependencies?: unknown };
  if (packageJson.license !== "Apache-2.0") {
    throw new Error("package.json must declare Apache-2.0");
  }
  if (
    !packageJson.dependencies ||
    typeof packageJson.dependencies !== "object" ||
    Array.isArray(packageJson.dependencies)
  ) {
    throw new Error("production dependency declarations are missing");
  }
  requireFileDigest(
    join(sourceRoot, "LICENSE"),
    APACHE_LICENSE_SHA256,
    "Apache-2.0 license",
  );
  requireFileDigest(
    join(sourceRoot, "NOTICE"),
    WORDHOLD_NOTICE_SHA256,
    "Wordhold copyright notice",
  );
  requireFileDigest(
    join(sourceRoot, "licenses", "bun-1.3.11", "LICENSE.md"),
    BUN_LICENSE_SHA256,
    "Bun 1.3.11 license",
  );
  requireFileDigest(
    join(sourceRoot, "licenses", "bun-1.3.11", "SOURCE.md"),
    BUN_SOURCE_NOTICE_SHA256,
    "Bun 1.3.11 source and relinking notice",
  );
  const dependencies = packageJson.dependencies as Record<string, string>;
  return {
    bunVersion: options.bunVersion,
    bunRevision: options.bunRevision,
    packages: verifyThirdPartyNotices(
      join(sourceRoot, "THIRD_PARTY_NOTICES.md"),
      options.nodeModules,
      dependencies,
    ),
  };
}

if (import.meta.main) {
  const sourceRoot = dirname(import.meta.dir);
  const nodeModules = join(sourceRoot, "node_modules");
  const packageJson = JSON.parse(
    readFileSync(join(sourceRoot, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  if (process.argv.includes("--generate")) {
    writeFileSync(
      join(sourceRoot, "THIRD_PARTY_NOTICES.md"),
      generateThirdPartyNotices(nodeModules, packageJson.dependencies ?? {}),
    );
    console.log(JSON.stringify({ status: "third-party-notices-generated" }));
  } else {
    console.log(JSON.stringify({
      status: "licenses-verified",
      ...verifyThirdPartyLicenses({
        sourceRoot,
        nodeModules,
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
      }),
    }));
  }
}
