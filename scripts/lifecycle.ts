import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { initializeDataRoot } from "../core/installation.ts";
import { atomicWriteFile } from "../core/atomic.ts";
import { verifyDistributionArtifact } from "../core/artifact.ts";
import { SHORTCUT_FILE } from "../core/shortcut-offer.ts";
import {
  preflightAgentIntegrationRemoval,
  removeAgentIntegrations,
} from "./install-agent-integrations.ts";
import {
  onlineOfferedShortcutRefreshNeeded,
  refreshOnlineOfferedShortcut,
} from "./configure-iphone.ts";

interface InstallReceiptV1 {
  format: 1;
  product: "papertrail";
  dataRoot: string;
  activeRelease: string;
}

interface InstallReceiptV2 {
  format: 2;
  product: "papertrail";
  dataRoot: string;
}

interface InstalledState {
  format: 1 | 2;
  dataRoot: string;
  activeRelease: string;
  artifactFormat: 2 | 3 | 4 | 5;
}

export interface InstallResult {
  dataRoot: string;
  activeRelease: string;
  changed: boolean;
  shortcutOffer: "unchanged" | "updated" | "repair_required";
}

export interface LifecycleOptions {
  sourceRoot: string;
  installRoot: string;
  dataRoot?: string;
  failAfterStage?: boolean;
  failAfterWrapper?: number;
  failAfterReceipt?: boolean;
  failShortcutRefresh?: boolean;
}

function absolute(path: string): string {
  return resolve(path);
}

function rejectSymlinkRoot(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("lifecycle roots cannot be symbolic links");
  }
}

function rejectBroadRoot(path: string): void {
  if (path === realpathSync("/") || path === canonicalTarget(homedir())) {
    throw new Error("refusing broad lifecycle root");
  }
}

function canonicalTarget(path: string): string {
  let ancestor = path;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...missing);
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function refreshActivatedShortcutOffer(
  dataRoot: string,
  artifact: string,
  needed: boolean,
  failForTest = false,
): InstallResult["shortcutOffer"] {
  if (!needed) return "unchanged";
  try {
    if (failForTest) throw new Error("simulated Shortcut offer refresh failure");
    return refreshOnlineOfferedShortcut(dataRoot, artifact) ? "updated" : "unchanged";
  } catch {
    // Activation is already durable. Report repair instead of pretending the
    // release rolled back after its single atomic pointer/rename transition.
    return "repair_required";
  }
}

function readInstallReceipt(installRoot: string): InstalledState | null {
  if (!existsSync(installRoot)) return null;
  if (!lstatSync(installRoot).isDirectory()) {
    throw new Error("program install root must be an absent or dedicated directory");
  }
  if (readdirSync(installRoot).length === 0) return null;
  const path = join(installRoot, "install.json");
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
    throw new Error(
      "refusing to install into a nonempty directory without a valid Wordhold receipt",
    );
  }
  let receipt: InstallReceiptV1 | InstallReceiptV2;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8")) as InstallReceiptV1 | InstallReceiptV2;
  } catch {
    throw new Error("refusing update: invalid Wordhold install receipt");
  }
  if (
    (receipt.format !== 1 && receipt.format !== 2) ||
    receipt.product !== "papertrail" ||
    !isAbsolute(receipt.dataRoot) ||
    (receipt.format === 1 && !/^[a-f0-9]{64}$/.test(receipt.activeRelease))
  ) {
    throw new Error("refusing update: invalid Wordhold install receipt");
  }
  const current = join(installRoot, "current");
  if (!existsSync(current) || !lstatSync(current).isSymbolicLink()) {
    throw new Error("refusing update: active Wordhold release pointer is invalid");
  }
  const releaseRoot = resolve(installRoot, readlinkSync(current));
  const releasesRoot = join(installRoot, "releases");
  const activeRelease = basename(releaseRoot);
  if (
    dirname(releaseRoot) !== releasesRoot ||
    !/^[a-f0-9]{64}$/.test(activeRelease) ||
    (receipt.format === 1 && activeRelease !== receipt.activeRelease) ||
    !existsSync(releaseRoot) ||
    lstatSync(releaseRoot).isSymbolicLink() ||
    !lstatSync(releaseRoot).isDirectory()
  ) {
    throw new Error("refusing update: recorded Wordhold release is missing or unsafe");
  }
  const artifact = verifyDistributionArtifact(releaseRoot);
  return {
    format: receipt.format,
    dataRoot: receipt.dataRoot,
    activeRelease,
    artifactFormat: artifact.manifest.format,
  };
}

function shellQuote(value: string): string {
  if (value.includes("\n") || value.includes("\0")) {
    throw new Error("installation paths may not contain control characters");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function wrapper(installRoot: string, dataRoot: string, binary: string): string {
  const target = binary === "papertrail" || binary === "wordhold"
    ? join(installRoot, "current", binary)
    : join(installRoot, "current", "bin", binary);
  return `#!/bin/sh\nPAPERTRAIL_ROOT=${shellQuote(dataRoot)} PAPERTRAIL_APP_ROOT=${shellQuote(join(installRoot, "current"))} PAPERTRAIL_INSTALL_ROOT=${shellQuote(installRoot)} exec ${shellQuote(target)} "$@"\n`;
}

function legacyWrapper(installRoot: string, dataRoot: string, binary: string): string {
  return `#!/bin/sh\nPAPERTRAIL_ROOT=${shellQuote(dataRoot)} PAPERTRAIL_APP_ROOT=${shellQuote(join(installRoot, "current"))} exec ${shellQuote(join(installRoot, "current", "bin", binary))} "$@"\n`;
}

function writeInstallReceipt(installRoot: string, dataRoot: string): void {
  const receipt: InstallReceiptV2 = {
    format: 2,
    product: "papertrail",
    dataRoot,
  };
  atomicWriteFile(
    join(installRoot, "install.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
}

function writeWrappers(
  destinationRoot: string,
  dataRoot: string,
  targetInstallRoot = destinationRoot,
  includeWordhold = true,
  afterWrite?: (count: number) => void,
): void {
  mkdirSync(join(destinationRoot, "bin"), { recursive: true, mode: 0o700 });
  // Format-4 artifacts introduce the preferred Wordhold command. Legacy
  // aliases remain because external automation and the current installation
  // may still invoke them; old artifacts never receive a wrapper whose target
  // they do not contain.
  const binaries = ["papertrail", "pt", "papertrail-mcp"];
  if (includeWordhold) binaries.push("wordhold");
  for (const [index, binary] of binaries.entries()) {
    const path = join(destinationRoot, "bin", binary);
    atomicWriteFile(path, wrapper(targetInstallRoot, dataRoot, binary));
    chmodSync(path, 0o700);
    afterWrite?.(index + 1);
  }
}

function validatedDataRoot(
  installRoot: string,
  rawDataRoot: string,
  requireInitialized: boolean,
): string {
  const absoluteRoot = absolute(rawDataRoot);
  rejectSymlinkRoot(absoluteRoot);
  const dataRoot = canonicalTarget(absoluteRoot);
  rejectBroadRoot(dataRoot);
  if (pathsOverlap(canonicalTarget(installRoot), dataRoot)) {
    throw new Error("program and private data roots must be separate");
  }
  if (requireInitialized) {
    for (const marker of ["papertrail.config.json", ".git"]) {
      const path = join(dataRoot, marker);
      if (
        !existsSync(path) ||
        lstatSync(path).isSymbolicLink() ||
        (marker === ".git" && !lstatSync(path).isDirectory()) ||
        (marker !== ".git" && !lstatSync(path).isFile())
      ) {
        throw new Error("recorded Wordhold private data root is missing or unsafe");
      }
    }
  }
  return dataRoot;
}

function atomicSymlink(target: string, path: string): void {
  const temp = `${path}.next-${randomUUID()}`;
  symlinkSync(target, temp);
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function verifyOwnedInstallInventory(
  installRoot: string,
  manifest: InstalledState,
): void {
  const allowedRoot = new Set([
    "agent-integrations.json",
    "bin",
    "current",
    "install.json",
    "releases",
  ]);
  for (const entry of readdirSync(installRoot)) {
    if (!allowedRoot.has(entry)) {
      throw new Error(`refusing uninstall: unowned program-root member: ${entry}`);
    }
  }

  const binRoot = join(installRoot, "bin");
  if (!existsSync(binRoot) || !lstatSync(binRoot).isDirectory()) {
    throw new Error("refusing uninstall: managed wrapper directory is missing or unsafe");
  }
  const binaries = readdirSync(binRoot).sort();
  const legacyInventory = ["papertrail-mcp", "pt"];
  const papertrailInventory = ["papertrail", "papertrail-mcp", "pt"];
  const currentInventory = ["papertrail", "papertrail-mcp", "pt", "wordhold"];
  const actual = JSON.stringify(binaries);
  const current = JSON.stringify(currentInventory);
  const valid = manifest.artifactFormat >= 4
    ? actual === current
    : actual === current ||
      actual === JSON.stringify(papertrailInventory) ||
      (manifest.format === 1 && actual === JSON.stringify(legacyInventory));
  if (!valid) {
    throw new Error("refusing uninstall: managed wrapper inventory changed");
  }
  for (const binary of binaries) {
    const path = join(binRoot, binary);
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      throw new Error(`refusing uninstall: managed wrapper changed: ${binary}`);
    }
    const contents = readFileSync(path, "utf8");
    const current = wrapper(installRoot, manifest.dataRoot, binary);
    const valid = manifest.format === 1 && binary !== "papertrail"
      ? contents === legacyWrapper(installRoot, manifest.dataRoot, binary) ||
        contents === current
      : contents === current;
    if (!valid) {
      throw new Error(`refusing uninstall: managed wrapper changed: ${binary}`);
    }
  }

  const releasesRoot = join(installRoot, "releases");
  if (!existsSync(releasesRoot) || !lstatSync(releasesRoot).isDirectory()) {
    throw new Error("refusing uninstall: managed releases directory is missing or unsafe");
  }
  for (const name of readdirSync(releasesRoot)) {
    if (!/^[a-f0-9]{64}$/.test(name)) {
      throw new Error(`refusing uninstall: unowned release member: ${name}`);
    }
    const path = join(releasesRoot, name);
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) {
      throw new Error(`refusing uninstall: unsafe release member: ${name}`);
    }
    const verified = verifyDistributionArtifact(path);
    if (verified.manifest.releaseId !== name) {
      throw new Error(`refusing uninstall: release directory identity mismatch: ${name}`);
    }
  }
}

export function installOrUpdate(options: LifecycleOptions): InstallResult {
  const sourceRoot = realpathSync(absolute(options.sourceRoot));
  const installRoot = absolute(options.installRoot);
  rejectSymlinkRoot(installRoot);
  const canonicalInstallRoot = canonicalTarget(installRoot);
  rejectBroadRoot(canonicalInstallRoot);
  const receipt = readInstallReceipt(installRoot);
  if (!options.dataRoot && !receipt) {
    throw new Error("private data root is required for first install");
  }
  if (
    receipt &&
    options.dataRoot &&
    canonicalTarget(absolute(options.dataRoot)) !==
      canonicalTarget(absolute(receipt.dataRoot))
  ) {
    throw new Error("refusing to repoint an existing Wordhold installation");
  }
  const dataRoot = validatedDataRoot(
    installRoot,
    options.dataRoot ?? receipt!.dataRoot,
    receipt !== null,
  );
  if (
    pathsOverlap(sourceRoot, canonicalInstallRoot) ||
    pathsOverlap(sourceRoot, dataRoot)
  ) {
    throw new Error("distribution source must be separate from program and private data roots");
  }
  const sourceArtifact = verifyDistributionArtifact(sourceRoot).manifest;
  if (receipt && sourceArtifact.format < receipt.artifactFormat) {
    throw new Error(
      "refusing to activate an older artifact format over this Wordhold installation",
    );
  }
  const release = sourceArtifact.releaseId;
  const includeWordhold = sourceArtifact.format >= 4;

  // A first install is assembled completely beside its final path, then moved
  // into place in one rename. A failed stage leaves private data initialized
  // but never strands a nonempty, receipt-less program root.
  if (!receipt) {
    initializeDataRoot(dataRoot);
    mkdirSync(dirname(installRoot), { recursive: true, mode: 0o700 });
    const stageRoot = join(
      dirname(installRoot),
      `.${basename(installRoot)}.stage-${release}-${randomUUID()}`,
    );
    try {
      mkdirSync(join(stageRoot, "releases"), { recursive: true, mode: 0o700 });
      cpSync(sourceRoot, join(stageRoot, "releases", release), {
        recursive: true,
        errorOnExist: true,
      });
      verifyDistributionArtifact(join(stageRoot, "releases", release));
      symlinkSync(join("releases", release), join(stageRoot, "current"));
      writeWrappers(stageRoot, dataRoot, installRoot, includeWordhold);
      writeInstallReceipt(stageRoot, dataRoot);
      const shortcutArtifact = join(
        stageRoot,
        "current",
        "integrations",
        "shortcuts",
        SHORTCUT_FILE,
      );
      const shortcutRefreshNeeded = onlineOfferedShortcutRefreshNeeded(dataRoot, shortcutArtifact);
      if (options.failAfterStage) throw new Error("simulated update failure after staging");
      if (existsSync(installRoot)) rmdirSync(installRoot);
      renameSync(stageRoot, installRoot);
      const shortcutOffer = refreshActivatedShortcutOffer(
        dataRoot,
        join(installRoot, "current", "integrations", "shortcuts", SHORTCUT_FILE),
        shortcutRefreshNeeded,
        options.failShortcutRefresh,
      );
      return { dataRoot, activeRelease: release, changed: true, shortcutOffer };
    } catch (error) {
      rmSync(stageRoot, { recursive: true, force: true });
      throw error;
    }
  }

  // Prove the entire owned program tree before adding or replacing anything.
  // Legacy v0.1 receipts and wrappers are accepted only in their exact form.
  verifyOwnedInstallInventory(installRoot, receipt);
  initializeDataRoot(dataRoot);
  mkdirSync(join(installRoot, "releases"), { recursive: true, mode: 0o700 });
  const destination = join(installRoot, "releases", release);
  if (!existsSync(destination)) {
    const stage = join(installRoot, "releases", `.stage-${release}-${randomUUID()}`);
    cpSync(sourceRoot, stage, { recursive: true, errorOnExist: true });
    try {
      verifyDistributionArtifact(stage);
      if (options.failAfterStage) throw new Error("simulated update failure after staging");
      renameSync(stage, destination);
    } catch (error) {
      rmSync(stage, { recursive: true, force: true });
      throw error;
    }
  } else {
    if (lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isDirectory()) {
      throw new Error("existing Wordhold release is not a dedicated directory");
    }
    verifyDistributionArtifact(destination);
    if (options.failAfterStage) {
      throw new Error("simulated update failure after staging");
    }
  }

  // Every fallible file replacement precedes the one atomic activation step.
  // Receipt v2 derives the active release from the current symlink, avoiding
  // two files that could disagree after a crash.
  writeWrappers(installRoot, dataRoot, installRoot, includeWordhold, (count) => {
    if (options.failAfterWrapper === count) {
      throw new Error(`simulated update failure after wrapper ${count}`);
    }
  });
  writeInstallReceipt(installRoot, dataRoot);
  if (options.failAfterReceipt) {
    throw new Error("simulated update failure after receipt");
  }
  const shortcutArtifact = join(
    destination,
    "integrations",
    "shortcuts",
    SHORTCUT_FILE,
  );
  const shortcutRefreshNeeded = onlineOfferedShortcutRefreshNeeded(dataRoot, shortcutArtifact);
  atomicSymlink(join("releases", release), join(installRoot, "current"));
  const changed = receipt.activeRelease !== release;
  const shortcutOffer = refreshActivatedShortcutOffer(
    dataRoot,
    join(installRoot, "current", "integrations", "shortcuts", SHORTCUT_FILE),
    shortcutRefreshNeeded,
    options.failShortcutRefresh,
  );
  return {
    dataRoot,
    activeRelease: release,
    changed,
    shortcutOffer,
  };
}

export function uninstallProgram(rawInstallRoot: string): { dataRoot: string } {
  const preflight = preflightUninstallProgram(rawInstallRoot);
  const installRoot = absolute(rawInstallRoot);
  const manifestPath = join(installRoot, "install.json");
  const integrationPath = join(installRoot, "agent-integrations.json");
  if (existsSync(integrationPath)) {
    removeAgentIntegrations({ installRoot });
  }
  // Delete only paths owned by this installer. Private dataRoot is deliberately
  // outside installRoot and remains untouched.
  rmSync(join(installRoot, "bin"), { recursive: true, force: true });
  rmSync(join(installRoot, "releases"), { recursive: true, force: true });
  rmSync(join(installRoot, "current"), { force: true });
  unlinkSync(manifestPath);
  return { dataRoot: preflight.dataRoot };
}

export function preflightUninstallProgram(
  rawInstallRoot: string,
): { dataRoot: string } {
  const installRoot = absolute(rawInstallRoot);
  rejectSymlinkRoot(installRoot);
  const canonicalInstallRoot = canonicalTarget(installRoot);
  rejectBroadRoot(canonicalInstallRoot);
  const manifest = readInstallReceipt(installRoot);
  if (!manifest) throw new Error("refusing uninstall: Wordhold install receipt is missing");
  const dataRoot = validatedDataRoot(installRoot, manifest.dataRoot, true);
  verifyOwnedInstallInventory(installRoot, manifest);
  const integrationPath = join(installRoot, "agent-integrations.json");
  if (existsSync(integrationPath)) {
    if (lstatSync(integrationPath).isSymbolicLink() || !lstatSync(integrationPath).isFile()) {
      throw new Error("refusing uninstall: agent integration receipt is unsafe");
    }
    preflightAgentIntegrationRemoval({ installRoot });
  }
  return { dataRoot };
}

export function installedDataRoot(rawInstallRoot: string): string {
  const installRoot = absolute(rawInstallRoot);
  rejectSymlinkRoot(installRoot);
  const manifest = readInstallReceipt(installRoot);
  if (!manifest) throw new Error("Wordhold is not installed");
  return validatedDataRoot(installRoot, manifest.dataRoot, true);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const command = process.argv[2];
  const installRoot = argument("--install-root") ??
    join(homedir(), "Library", "Application Support", "Papertrail", "app");
  if (command === "uninstall") {
    console.log(JSON.stringify({ status: "uninstalled", ...uninstallProgram(installRoot) }));
  } else if (command === "install" || command === "update") {
    const sourceRoot = argument("--source") ?? dirname(import.meta.dir);
    const requestedDataRoot = argument("--data-root");
    const dataRoot = command === "install"
      ? requestedDataRoot ??
        join(homedir(), "Library", "Application Support", "Papertrail", "data")
      : requestedDataRoot;
    const result = installOrUpdate({
      sourceRoot,
      installRoot,
      dataRoot,
      failAfterStage: process.env.PAPERTRAIL_TEST_FAIL_AFTER_STAGE === "1",
      failShortcutRefresh: process.env.PAPERTRAIL_TEST_FAIL_SHORTCUT_REFRESH === "1",
    });
    console.log(JSON.stringify({ status: command === "install" ? "installed" : "updated", ...result }));
  } else {
    throw new Error("usage: lifecycle <install|update|uninstall> [--source DIR] [--install-root DIR] [--data-root DIR]");
  }
}
