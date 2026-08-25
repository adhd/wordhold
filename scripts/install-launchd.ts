// Compiles the FDA-sensitive daemon to a stable path, renders four launch
// agents with absolute paths, and loads them into the current GUI session.
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicCopyFile, atomicWriteFile } from "../core/atomic.ts";
import { resolveRepoRoot } from "../core/config.ts";
import { capabilityMode, loadConfig } from "../core/config.ts";

interface RenderOptions {
  repoRoot: string;
  bunPath: string;
  appRoot?: string;
  labelPrefix?: string;
  enabledJobs?: Array<"enrich" | "digest" | "resurface">;
  packagedBinaries?: boolean;
}

interface Job {
  label: string;
  args: string[];
  schedule: string;
}

const JOB_NAMES = ["daemon", "enrich", "digest", "resurface"] as const;
const RECEIPT_SUFFIX = "launchd-install.json";

interface LaunchdReceipt {
  format: 1;
  product: "papertrail";
  repoRoot: string;
  files: Record<string, string>;
}

type LaunchctlRunner = (args: string[]) => number;

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function launchdReceiptPath(destination: string, prefix: string): string {
  return join(destination, `${prefix}.${RECEIPT_SUFFIX}`);
}

function runLaunchctl(args: string[]): number {
  return Bun.spawnSync(["launchctl", ...args], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode;
}

function readLaunchdReceipt(
  destination: string,
  prefix: string,
): LaunchdReceipt | null {
  const path = launchdReceiptPath(destination, prefix);
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error("invalid Wordhold launchd receipt");
  }
  const receipt = JSON.parse(readFileSync(path, "utf8")) as LaunchdReceipt;
  const allowed = new Set(JOB_NAMES.map((job) => `${prefix}.${job}.plist`));
  if (
    receipt.format !== 1 ||
    receipt.product !== "papertrail" ||
    typeof receipt.repoRoot !== "string" ||
    !receipt.files ||
    Object.values(receipt.files).some((digest) => !/^[a-f0-9]{64}$/.test(digest)) ||
    !receipt.files[`${prefix}.daemon.plist`] ||
    Object.keys(receipt.files).some((name) => !allowed.has(name))
  ) {
    throw new Error("invalid Wordhold launchd receipt");
  }
  return receipt;
}

function preflightLaunchdFiles(
  destination: string,
  prefix: string,
  receipt: LaunchdReceipt | null,
  desired?: Record<string, string>,
): void {
  for (const name of JOB_NAMES.map((job) => `${prefix}.${job}.plist`)) {
    const path = join(destination, name);
    if (!existsSync(path)) {
      if (receipt?.files[name] && (desired === undefined || desired[name] !== undefined)) {
        throw new Error(`managed launchd file is missing: ${path}`);
      }
      continue;
    }
    const current = sha256(readFileSync(path, "utf8"));
    const expectedPrior = receipt?.files[name];
    const expectedNext = desired?.[name] === undefined
      ? undefined
      : sha256(desired[name]);
    if (current !== expectedPrior && current !== expectedNext) {
      throw new Error(`refusing to replace changed or unmanaged launchd file: ${path}`);
    }
  }
}

function bootoutIfLoaded(
  label: string,
  path: string,
  domain: string,
  runner: LaunchctlRunner,
): void {
  if (runner(["print", `${domain}/${label}`]) !== 0) return;
  if (runner(["bootout", domain, path]) !== 0) {
    throw new Error(`launchctl bootout failed; preserving ${path}`);
  }
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderJob(repoRoot: string, appRoot: string, job: Job): string {
  const args = job.args.map((arg) => `      <string>${xml(arg)}</string>`).join("\n");
  const logBase = join(repoRoot, "logs", job.label);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${job.label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PAPERTRAIL_ROOT</key>
    <string>${xml(repoRoot)}</string>
    <key>PAPERTRAIL_APP_ROOT</key>
    <string>${xml(appRoot)}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  ${job.schedule}
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(logBase)}.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${xml(logBase)}.stderr.log</string>
</dict>
</plist>
`;
}

export function renderLaunchAgents(opts: RenderOptions): Record<string, string> {
  const appRoot = opts.appRoot ?? opts.repoRoot;
  const prefix = opts.labelPrefix ?? "app.papertrail";
  const enabled = new Set(opts.enabledJobs ?? ["enrich", "digest", "resurface"]);
  const program = (name: string, source: string): string[] =>
    opts.packagedBinaries
      ? [join(appRoot, "bin", `papertrail-${name}`)]
      : [opts.bunPath, join(appRoot, source)];
  const daemon = join(opts.repoRoot, "dist", "papertrail-daemon");
  const jobs: Job[] = [
    {
      label: `${prefix}.daemon`,
      args: [daemon],
      schedule: "<key>RunAtLoad</key>\n  <true/>\n  <key>StartInterval</key>\n    <integer>300</integer>",
    },
    {
      label: `${prefix}.enrich`,
      args: program("enrich", "agent/enrich.ts"),
      schedule: "<key>StartCalendarInterval</key>\n  <dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer></dict>",
    },
    {
      label: `${prefix}.digest`,
      args: program("digest", "daemon/digest.ts"),
      schedule: "<key>StartCalendarInterval</key>\n  <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>",
    },
    {
      label: `${prefix}.resurface`,
      args: program("resurface", "daemon/resurface.ts"),
      schedule: "<key>StartCalendarInterval</key>\n  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>",
    },
  ];
  return Object.fromEntries(
    jobs
      .filter((job) => job.label.endsWith(".daemon") || enabled.has(job.label.split(".").at(-1) as never))
      .map((job) => [`${job.label}.plist`, renderJob(opts.repoRoot, appRoot, job)]),
  );
}

/** Preserve the stable daemon inode when an update ships identical bytes.
 * macOS Full Disk Access is attached to this stable executable; replacing it
 * unnecessarily can invalidate an otherwise-current owner grant.
 */
export function syncPackagedDaemon(
  packagedDaemon: string,
  installedDaemon: string,
): "preserved" | "replaced" {
  const packagedStat = lstatSync(packagedDaemon);
  if (packagedStat.isSymbolicLink() || !packagedStat.isFile()) {
    throw new Error("packaged daemon must be a real file");
  }
  if (existsSync(installedDaemon)) {
    const installedStat = lstatSync(installedDaemon);
    if (installedStat.isSymbolicLink() || !installedStat.isFile()) {
      throw new Error("stable daemon must be a real file");
    }
  }
  if (
    existsSync(installedDaemon) &&
    readFileSync(installedDaemon).equals(readFileSync(packagedDaemon))
  ) {
    chmodSync(installedDaemon, 0o700);
    return "preserved";
  }
  atomicCopyFile(packagedDaemon, installedDaemon);
  chmodSync(installedDaemon, 0o700);
  return "replaced";
}

function desiredLaunchAgents(
  repoRoot: string,
  destination: string,
  appRoot: string,
): {
  prior: LaunchdReceipt | null;
  rendered: Record<string, string>;
  packagedDaemon: string;
} {
  const bunPath = process.execPath;
  const prefix = "app.papertrail";
  const prior = readLaunchdReceipt(destination, prefix);
  if (prior && prior.repoRoot !== repoRoot) {
    throw new Error(`launchd receipt belongs to a different Wordhold root: ${prior.repoRoot}`);
  }
  const packagedDaemon = join(appRoot, "bin", "papertrail-daemon");
  const config = loadConfig(repoRoot);
  const enabledJobs: RenderOptions["enabledJobs"] = [];
  if (capabilityMode(config, "enrichment") === "enabled") enabledJobs.push("enrich");
  if (capabilityMode(config, "digest") === "enabled") enabledJobs.push("digest");
  if (capabilityMode(config, "resurfacing") === "enabled") enabledJobs.push("resurface");
  const rendered = renderLaunchAgents({
    repoRoot,
    appRoot,
    bunPath,
    enabledJobs,
    packagedBinaries: existsSync(packagedDaemon),
  });
  return { prior, rendered, packagedDaemon };
}

/**
 * Validate an existing schedule against both its receipt and the exact desired
 * definitions without changing files, binaries, or launchd state. Updates use
 * this before activating a release so local edits fail closed.
 */
export function preflightLaunchAgentInstall(
  repoRoot: string,
  destination = join(homedir(), "Library", "LaunchAgents"),
  appRoot = dirname(import.meta.dir),
): boolean {
  const { prior, rendered } = desiredLaunchAgents(repoRoot, destination, appRoot);
  preflightLaunchdFiles(destination, "app.papertrail", prior, rendered);
  return prior !== null;
}

async function runChecked(args: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args[0]} failed: ${stderr.trim()}`);
}

export async function installLaunchAgents(
  repoRoot: string,
  destination = join(homedir(), "Library", "LaunchAgents"),
  appRoot = dirname(import.meta.dir),
): Promise<string[]> {
  const bunPath = process.execPath;
  const prefix = "app.papertrail";
  const { prior, rendered, packagedDaemon } = desiredLaunchAgents(
    repoRoot,
    destination,
    appRoot,
  );
  // Exact old or exact desired bytes are both recoverable. This permits a
  // retry after interruption between plist writes and receipt activation while
  // continuing to reject arbitrary or locally edited definitions.
  preflightLaunchdFiles(destination, prefix, prior, rendered);
  const distDir = join(repoRoot, "dist");
  mkdirSync(distDir, { recursive: true });
  const distStat = lstatSync(distDir);
  if (distStat.isSymbolicLink() || !distStat.isDirectory()) {
    throw new Error("Wordhold daemon directory must be a real directory");
  }
  mkdirSync(join(repoRoot, "logs"), { recursive: true });
  const installedDaemon = join(distDir, "papertrail-daemon");
  if (existsSync(packagedDaemon)) {
    syncPackagedDaemon(packagedDaemon, installedDaemon);
  } else {
    await runChecked(
      [
        bunPath,
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--reject-unresolved",
        join(appRoot, "daemon", "main.ts"),
        "--outfile",
        installedDaemon,
      ],
      appRoot,
    );
  }

  mkdirSync(destination, { recursive: true });
  const paths: string[] = [];
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("launchd install requires a Unix user id");
  const domain = `gui/${uid}`;
  const nextNames = new Set(Object.keys(rendered));
  for (const name of Object.keys(prior?.files ?? {})) {
    if (nextNames.has(name)) continue;
    const path = join(destination, name);
    if (!existsSync(path)) continue;
    bootoutIfLoaded(name.slice(0, -".plist".length), path, domain, runLaunchctl);
    unlinkSync(path);
  }
  for (const [name, contents] of Object.entries(rendered)) {
    const path = join(destination, name);
    if (existsSync(path)) {
      bootoutIfLoaded(name.slice(0, -".plist".length), path, domain, runLaunchctl);
    }
    atomicWriteFile(path, contents);
    paths.push(path);
  }
  const receipt: LaunchdReceipt = {
    format: 1,
    product: "papertrail",
    repoRoot,
    files: Object.fromEntries(
      Object.entries(rendered).map(([name, contents]) => [name, sha256(contents)]),
    ),
  };
  atomicWriteFile(
    launchdReceiptPath(destination, prefix),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  for (const path of paths) {
    await runChecked(["launchctl", "bootstrap", domain, path]);
  }
  return paths;
}

export function reconcileLaunchAgentFilesForTest(
  repoRoot: string,
  destination: string,
  rendered: Record<string, string>,
  labelPrefix = "app.papertrail",
): string[] {
  mkdirSync(destination, { recursive: true });
  const prior = readLaunchdReceipt(destination, labelPrefix);
  if (prior && prior.repoRoot !== repoRoot) throw new Error("launchd receipt root changed");
  preflightLaunchdFiles(destination, labelPrefix, prior, rendered);
  const next = new Set(Object.keys(rendered));
  for (const name of Object.keys(prior?.files ?? {})) {
    const path = join(destination, name);
    if (!next.has(name) && existsSync(path)) unlinkSync(path);
  }
  for (const [name, contents] of Object.entries(rendered)) {
    atomicWriteFile(join(destination, name), contents);
  }
  const receipt: LaunchdReceipt = {
    format: 1,
    product: "papertrail",
    repoRoot,
    files: Object.fromEntries(
      Object.entries(rendered).map(([name, contents]) => [name, sha256(contents)]),
    ),
  };
  atomicWriteFile(
    launchdReceiptPath(destination, labelPrefix),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  return [...next].map((name) => join(destination, name));
}

/**
 * Remove only recognizable Wordhold plists. Preflight every existing file
 * before booting out any job so a locally replaced plist is never partly
 * removed alongside installer-owned definitions.
 */
export async function uninstallLaunchAgents(
  destination = join(homedir(), "Library", "LaunchAgents"),
  labelPrefix = "app.papertrail",
  activate = true,
  runner: LaunchctlRunner = runLaunchctl,
): Promise<string[]> {
  const { paths } = preflightLaunchAgentUninstall(destination, labelPrefix);
  const receipt = readLaunchdReceipt(destination, labelPrefix);

  if (activate) {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("launchd uninstall requires a Unix user id");
    const domain = `gui/${uid}`;
    for (const { label, path } of paths) {
      bootoutIfLoaded(label, path, domain, runner);
    }
  }
  for (const { path } of paths) unlinkSync(path);
  if (receipt) unlinkSync(launchdReceiptPath(destination, labelPrefix));
  return paths.map(({ path }) => path);
}

export function preflightLaunchAgentUninstall(
  destination = join(homedir(), "Library", "LaunchAgents"),
  labelPrefix = "app.papertrail",
): { repoRoot: string | null; paths: Array<{ label: string; path: string }> } {
  const receipt = readLaunchdReceipt(destination, labelPrefix);
  const paths = Object.keys(receipt?.files ?? {}).map((name) => ({
    label: name.slice(0, -".plist".length),
    path: join(destination, name),
  }));
  if (!receipt && JOB_NAMES.some((name) => existsSync(join(destination, `${labelPrefix}.${name}.plist`)))) {
    throw new Error("refusing to remove launchd files without a Wordhold receipt");
  }
  preflightLaunchdFiles(destination, labelPrefix, receipt);
  return { repoRoot: receipt?.repoRoot ?? null, paths };
}

if (import.meta.main) {
  if (process.argv.includes("--uninstall")) {
    const paths = await uninstallLaunchAgents();
    console.log(`removed ${paths.length} Wordhold launch agents`);
  } else {
    const repoRoot = resolveRepoRoot();
    const paths = await installLaunchAgents(repoRoot);
    console.log(`installed ${paths.length} Wordhold launch agents`);
    console.log(`grant Full Disk Access to ${join(repoRoot, "dist", "papertrail-daemon")}`);
  }
}
