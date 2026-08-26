import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { atomicWriteFile } from "./atomic.ts";
import { openDb } from "./db.ts";
import { spawnGitSync } from "./git.ts";

const SAFE_CONFIG = {
  capabilities: {
    workerInbox: false,
    icloudInbox: false,
    readingList: false,
    enrichment: false,
    digest: false,
    resurfacing: false,
  },
  worker: { baseUrl: "", secret: "" },
  icloudInboxDir: "",
  readingListPlist: "",
  imessage: { recipient: "", dryRun: true },
  enrichment: { minBodyChars: 600, maxFetchAttempts: 5 },
};

export const DATA_IGNORE = `papertrail.config.json
wordhold.config.json
.env
.env.*
.dev.vars
.dev.vars.*
.scratch/
papertrail.db*
wordhold.db*
inbox/
dist/
logs/*.log
logs/bad-captures/
logs/bad-worker-captures.jsonl
logs/bad-worker-captures-seen.txt
logs/quarantine.jsonl
logs/quarantine-seen.txt
logs/oversized-worker-bodies.jsonl
logs/oversized-worker-bodies-seen.txt
.DS_Store
`;

function runGit(root: string, args: string[], allowOne = false): number {
  const result = spawnGitSync(root, args);
  if (result.exitCode !== 0 && !(allowOne && result.exitCode === 1)) {
    throw new Error(
      `git ${args[0]} failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  return result.exitCode;
}

function writeIfMissing(path: string, contents: string): void {
  if (!existsSync(path)) atomicWriteFile(path, contents);
}

function requireRealDirectory(path: string, label: string): void {
  if (
    existsSync(path) &&
    (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())
  ) {
    throw new Error(`unsafe existing Wordhold ${label}`);
  }
}

function requireRealFile(path: string, label: string): void {
  if (
    existsSync(path) &&
    (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())
  ) {
    throw new Error(`unsafe existing Wordhold ${label}`);
  }
}

/** Prove every path initialization may write before changing any of them. */
function preflightDataRoot(dataRoot: string): { existed: boolean; populated: boolean } {
  const existed = existsSync(dataRoot);
  if (!existed) return { existed: false, populated: false };
  if (lstatSync(dataRoot).isSymbolicLink() || !lstatSync(dataRoot).isDirectory()) {
    throw new Error("Wordhold data root must be a real directory");
  }
  const populated = readdirSync(dataRoot).length > 0;
  for (const relative of [".git", "agent", "logs", "items", "inbox", "dist"]) {
    requireRealDirectory(join(dataRoot, relative), relative);
  }
  for (const relative of [
    "papertrail.config.json",
    ".gitignore",
    "README.md",
    ".env",
    "agent/tags.md",
    "logs/new-tags.jsonl",
    "logs/resurfacing.jsonl",
    "papertrail.db",
    "papertrail.db-wal",
    "papertrail.db-shm",
  ]) {
    requireRealFile(join(dataRoot, relative), relative);
  }
  if (
    populated &&
    (!existsSync(join(dataRoot, "papertrail.config.json")) ||
      !existsSync(join(dataRoot, ".git")))
  ) {
    throw new Error(
      "refusing to initialize a non-empty directory without real Wordhold config and Git markers",
    );
  }
  return { existed: true, populated };
}

export interface InitializedDataRoot {
  dataRoot: string;
  createdConfig: boolean;
  createdGit: boolean;
}

/**
 * Create an independent private corpus authority. No optional integration is
 * enabled and no network, model, message, cloud, or device API is contacted.
 */
export function initializeDataRoot(rawRoot: string): InitializedDataRoot {
  let gitAvailable = false;
  try {
    gitAvailable = spawnGitSync(undefined, ["--version"]).exitCode === 0;
  } catch {
    gitAvailable = false;
  }
  if (!gitAvailable) {
    throw new Error(
      "Git is required before Wordhold setup; install Apple Command Line Tools (xcode-select --install), then retry.",
    );
  }
  const dataRoot = isAbsolute(rawRoot) ? rawRoot : resolve(rawRoot);
  const { existed } = preflightDataRoot(dataRoot);
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  chmodSync(dataRoot, 0o700);

  const configPath = join(dataRoot, "papertrail.config.json");
  const createdConfig = !existsSync(configPath);
  writeIfMissing(configPath, JSON.stringify(SAFE_CONFIG, null, 2) + "\n");
  writeIfMissing(join(dataRoot, ".gitignore"), DATA_IGNORE);
  writeIfMissing(
    join(dataRoot, "README.md"),
    "# Wordhold private data\n\nThis Git repository is the canonical private corpus. Do not publish it.\n",
  );
  writeIfMissing(join(dataRoot, "agent", "tags.md"), "# Wordhold tags\n\n");
  writeIfMissing(join(dataRoot, "logs", "new-tags.jsonl"), "");
  writeIfMissing(join(dataRoot, "logs", "resurfacing.jsonl"), "");

  const createdGit = !existsSync(join(dataRoot, ".git"));
  if (createdGit) {
    runGit(dataRoot, ["init", "-q", "--template="]);
    runGit(dataRoot, ["config", "user.name", "Wordhold"]);
    runGit(dataRoot, ["config", "user.email", "wordhold@localhost.invalid"]);
    runGit(dataRoot, ["config", "commit.gpgsign", "false"]);
  }
  const trackedBaseline = [
    ".gitignore",
    "README.md",
    "agent/tags.md",
    "logs/new-tags.jsonl",
    "logs/resurfacing.jsonl",
  ];
  runGit(dataRoot, ["add", "--", ...trackedBaseline]);
  if (runGit(dataRoot, ["diff", "--cached", "--quiet"], true) === 1) {
    runGit(dataRoot, [
      "commit",
      "--no-gpg-sign",
      "-qm",
      createdGit ? "initialize private Wordhold corpus" : "initialize missing Wordhold authority files",
      "--",
      ...trackedBaseline,
    ]);
  }

  // The index is disposable, but creating it now makes the local-only install
  // immediately diagnosable and searchable without starting any job.
  openDb(dataRoot).close();
  return { dataRoot, createdConfig, createdGit };
}

export function safeConfigText(): string {
  return JSON.stringify(SAFE_CONFIG, null, 2) + "\n";
}
