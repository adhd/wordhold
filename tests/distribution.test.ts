import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  artifactReleaseId,
  assertReviewedDistributionTree,
  assertReviewedDistributionSources,
  buildDistribution,
  type ArtifactManifest,
} from "../scripts/build-distribution.ts";
import { packageDistribution } from "../scripts/package-distribution.ts";
import { openDb } from "../core/db.ts";
import { appendHighlight, ingestCapture, recordFetchResult } from "../core/store.ts";
import {
  configureIphoneCapture,
  configureOnlineIphoneCapture,
} from "../scripts/configure-iphone.ts";
import { withFakeAgentClients } from "./helpers/fake-agent-clients.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("every allowlisted distribution source must be Git-tracked", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-reviewed-source-"));
  roots.push(root);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "README.md"), "tracked\n");
  writeFileSync(join(root, "docs", "setup.md"), "initially tracked\n");
  run(["git", "init", "-q", root]);
  git(root, "config", "user.name", "Papertrail Test");
  git(root, "config", "user.email", "papertrail@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "--", "README.md", "docs/setup.md");
  git(root, "commit", "-qm", "review sources");
  expect(() => assertReviewedDistributionSources(root, ["README.md", "docs/setup.md"]))
    .not.toThrow();
  git(root, "rm", "--cached", "-f", "--", "docs/setup.md");
  expect(() => assertReviewedDistributionSources(root, ["README.md", "docs/setup.md"]))
    .toThrow("distribution source member is not Git-tracked: docs/setup.md");
});

test("every distributed source byte must match HEAD despite hidden worktree changes", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const root = mkdtempSync(join(tmpdir(), "pt-reviewed-head-source-"));
    roots.push(root);
    writeFileSync(join(root, "README.md"), "reviewed source\n");
    run(["git", "init", "-q", root]);
    git(root, "config", "user.name", "Papertrail Test");
    git(root, "config", "user.email", "papertrail@example.invalid");
    git(root, "config", "commit.gpgsign", "false");
    git(root, "add", "--", "README.md");
    git(root, "commit", "-qm", "review source");
    git(root, "update-index", flag, "README.md");
    writeFileSync(join(root, "README.md"), "unreviewed release bytes\n");

    expect(git(root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    expect(() => assertReviewedDistributionSources(root, ["README.md"]))
      .toThrow("distribution source member differs from HEAD: README.md");
  }
});

test("a hidden deletion cannot remove a tracked distribution tree member", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-reviewed-tree-source-"));
  roots.push(root);
  mkdirSync(join(root, "core"));
  writeFileSync(join(root, "core", "contract.ts"), "export const contract = true;\n");
  run(["git", "init", "-q", root]);
  git(root, "config", "user.name", "Papertrail Test");
  git(root, "config", "user.email", "papertrail@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "--", "core/contract.ts");
  git(root, "commit", "-qm", "review tree");
  git(root, "update-index", "--skip-worktree", "core/contract.ts");
  rmSync(join(root, "core", "contract.ts"));

  expect(git(root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  expect(() => assertReviewedDistributionTree(root, "core"))
    .toThrow(/source tree differs from Git inventory; missing: core\/contract\.ts/);
});

function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(args, { env: { ...process.env, ...env } });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout);
}

function git(root: string, ...args: string[]): string {
  return run(["git", ...args], { GIT_DIR: join(root, ".git"), GIT_WORK_TREE: root }).trim();
}

function lifecycle(
  command: "install" | "update" | "uninstall",
  sourceRoot: string,
  installRoot: string,
  dataRoot?: string,
  env: Record<string, string> = {},
): ReturnType<typeof Bun.spawnSync> {
  const script = command === "install"
    ? join(sourceRoot, "scripts", "lifecycle.ts")
    : join(installRoot, "current", "scripts", "lifecycle.ts");
  return Bun.spawnSync(
    [
      process.execPath,
      script,
      command,
      ...(command === "uninstall" ? [] : ["--source", sourceRoot]),
      "--install-root",
      installRoot,
      ...(dataRoot ? ["--data-root", dataRoot] : []),
    ],
    { env: { ...process.env, ...env } },
  );
}

function lifecycleJson(
  command: "install" | "update" | "uninstall",
  sourceRoot: string,
  installRoot: string,
  dataRoot?: string,
  env: Record<string, string> = {},
): Record<string, unknown> {
  const result = lifecycle(command, sourceRoot, installRoot, dataRoot, env);
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

function forkArtifact(source: string, destination: string, changeShortcut = false): void {
  cpSync(source, destination, { recursive: true });
  const readme = join(destination, "README.md");
  writeFileSync(readme, readFileSync(readme, "utf8") + "\nUpdate fixture.\n");
  const manifestPath = join(destination, ".papertrail-artifact.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ArtifactManifest;
  manifest.files["README.md"] = createHash("sha256")
    .update(readFileSync(readme))
    .digest("hex");
  if (changeShortcut) {
    const shortcut = join(
      destination,
      "integrations",
      "shortcuts",
      "Save to Papertrail — Online.shortcut",
    );
    writeFileSync(shortcut, Buffer.concat([readFileSync(shortcut), Buffer.from("update-fixture")]));
    const shortcutDigest = createHash("sha256")
      .update(readFileSync(shortcut))
      .digest("hex");
    manifest.files["integrations/shortcuts/Save to Papertrail — Online.shortcut"] =
      shortcutDigest;
    const offerPath = join(
      destination,
      "integrations",
      "shortcuts",
      "Papertrail.offer.json",
    );
    const offer = JSON.parse(readFileSync(offerPath, "utf8"));
    offer.sha256 = shortcutDigest;
    writeFileSync(offerPath, JSON.stringify(offer, null, 2) + "\n");
    manifest.files["integrations/shortcuts/Papertrail.offer.json"] = createHash("sha256")
      .update(readFileSync(offerPath))
      .digest("hex");
  }
  manifest.releaseId = artifactReleaseId(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

async function mcpSearch(command: string, dataRoot: string, query: string) {
  const client = new Client({ name: "clean-install-proof", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command,
    env: { PATH: process.env.PATH ?? "", PAPERTRAIL_ROOT: dataRoot },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    return await client.callTool({ name: "search_items", arguments: { query } });
  } finally {
    await client.close();
  }
}

function captureOnlyFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
  const authorization = new Headers(
    input instanceof Request ? input.headers : init?.headers,
  ).get("authorization");
  if (
    path === "/v1/drain" &&
    authorization === "Bearer package-test-admin-secret"
  ) {
    return Promise.resolve(Response.json({ rows: [], nextCursor: null }));
  }
  const captureErrors: Record<string, string> = {
    "/v1/save": "save url required",
    "/v1/highlight": "highlight text required",
    "/v1/capture": "note text required",
  };
  return Promise.resolve(new Response(JSON.stringify({
    error: captureErrors[path] ?? "capture credential cannot access this route",
  }), {
    status: path in captureErrors ? 400 : 403,
  }));
}

test("sanitized artifact proves clean install, isolation, update safety, rebuild, and preserved-data uninstall", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pt-distribution-"));
  roots.push(temp);
  const sourceRoot = join(import.meta.dir, "..");
  const artifact = buildDistribution(sourceRoot, join(temp, "artifact-v1"));
  const artifactPaths = [
    ...new Bun.Glob("**/*").scanSync({ cwd: artifact, dot: true, onlyFiles: true }),
  ];
  const licenseMembers = [
    "LICENSE",
    "NOTICE",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "licenses/bun-1.3.11/LICENSE.md",
    "licenses/bun-1.3.11/SOURCE.md",
  ];
  for (const member of licenseMembers) {
    expect(artifactPaths).toContain(member);
    expect(readFileSync(join(artifact, member))).toEqual(
      readFileSync(join(sourceRoot, member)),
    );
  }
  expect(readFileSync(join(artifact, "THIRD_PARTY_NOTICES.md"), "utf8"))
    .toContain("@mozilla/readability@0.6.0 — Apache-2.0");
  expect(readFileSync(join(artifact, "licenses/bun-1.3.11/LICENSE.md"), "utf8"))
    .toContain("Bun statically links JavaScriptCore (and WebKit) which is LGPL-2 licensed");
  expect(artifactPaths.some((path) => path.includes(".git/"))).toBe(false);
  expect(artifactPaths.some((path) => path.startsWith("items/"))).toBe(false);
  expect(artifactPaths.some((path) => /papertrail\.db|inbox\/|logs\/.*\.log/.test(path))).toBe(false);
  const shortcutMember =
    "integrations/shortcuts/Save to Papertrail — Online.shortcut";
  const sourceShortcut = readFileSync(join(sourceRoot, shortcutMember));
  const packagedShortcut = readFileSync(join(artifact, shortcutMember));
  expect(packagedShortcut).toEqual(sourceShortcut);
  const manifest = JSON.parse(
    readFileSync(join(artifact, ".papertrail-artifact.json"), "utf8"),
  ) as ArtifactManifest;
  expect(manifest.files[shortcutMember]).toBe(
    createHash("sha256").update(sourceShortcut).digest("hex"),
  );
  const executablePaths = new Set(manifest.executables);
  const artifactText = artifactPaths
    .filter((path) =>
      !executablePaths.has(path) &&
      path !== shortcutMember &&
      !path.endsWith(".shortcut")
    )
    .map((path) => readFileSync(join(artifact, path), "utf8"))
    .join("\n");
  expect(artifactText).not.toContain("/Users/");
  expect(artifactText).not.toMatch(/\bpt_[a-z0-9]{10}\b/);
  const packaged = packageDistribution(
    artifact,
    join(temp, "artifact-v1.tar.gz"),
    { allowDirty: true },
  );
  expect(packaged.bytes).toBeGreaterThan(0);
  expect(packaged.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(() => packageDistribution(
    artifact,
    packaged.archive,
    { allowDirty: true },
  )).toThrow("release archive already exists");
  const artifactAlias = join(temp, "artifact-alias");
  symlinkSync(artifact, artifactAlias);
  expect(() => packageDistribution(
    artifact,
    join(artifactAlias, "nested.tar.gz"),
    { allowDirty: true },
  )).toThrow("outside the artifact directory");
  const archiveListing = run(["tar", "-tzvf", packaged.archive]);
  expect(
    archiveListing.split("\n").filter(Boolean).every(
      (line) => /^\S+\s+\d+\s+root\s+wheel\s+/.test(line),
    ),
  ).toBe(true);
  const recipientExtraction = join(temp, "recipient-extraction");
  mkdirSync(recipientExtraction);
  run(["tar", "-xzf", packaged.archive, "-C", recipientExtraction]);
  const handoffArtifact = join(recipientExtraction, basename(artifact));
  expect(readFileSync(join(handoffArtifact, shortcutMember))).toEqual(sourceShortcut);
  for (const path of artifactPaths.filter((path) => path.endsWith(".md"))) {
    const absolute = join(artifact, path);
    for (const match of readFileSync(absolute, "utf8").matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1]!.replace(/^<|>$/g, "").split("#")[0]!;
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      expect(existsSync(resolve(dirname(absolute), target)), `${path} -> ${target}`).toBe(true);
    }
  }

  const unrelated = join(temp, "unrelated-data");
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, "keep.txt"), "operator data\n");
  const mistaken = lifecycle(
    "install",
    artifact,
    join(temp, "mistyped-install"),
    unrelated,
  );
  expect(mistaken.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(mistaken.stderr)).toContain(
    "refusing to initialize a non-empty directory",
  );
  expect(readFileSync(join(unrelated, "keep.txt"), "utf8")).toBe("operator data\n");
  expect(existsSync(join(unrelated, "papertrail.config.json"))).toBe(false);

  const installRoot = join(temp, "install-one");
  const dataRoot = join(temp, "data-one");
  const first = lifecycleJson("install", handoffArtifact, installRoot, dataRoot);
  const configPath = join(dataRoot, "papertrail.config.json");
  const configBefore = readFileSync(configPath, "utf8");
  expect(statSync(dataRoot).mode & 0o777).toBe(0o700);
  expect(statSync(configPath).mode & 0o777).toBe(0o600);
  expect(JSON.parse(configBefore).capabilities).toEqual({
    workerInbox: false,
    icloudInbox: false,
    readingList: false,
    enrichment: false,
    digest: false,
    resurfacing: false,
  });
  expect(existsSync(join(dataRoot, "logs", "outbox.log"))).toBe(false);

  const papertrail = join(installRoot, "bin", "papertrail");
  const pt = join(installRoot, "bin", "pt");
  const daemon = join(installRoot, "current", "bin", "papertrail-daemon");
  const mcp = join(installRoot, "current", "bin", "papertrail-mcp");
  const clientHomes = join(temp, "client-homes");
  const codexHome = join(clientHomes, "codex");
  const hermesHome = join(clientHomes, "hermes");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(hermesHome, { recursive: true });
  const clientEnv = withFakeAgentClients(clientHomes, {
    ...process.env,
    CODEX_HOME: codexHome,
    HERMES_HOME: hermesHome,
  });
  for (const client of ["codex", "hermes"]) {
    run(
      [
        process.execPath,
        join(installRoot, "current", "scripts", "install-agent-integrations.ts"),
        "--data-root",
        dataRoot,
        "--client",
        client,
      ],
      clientEnv,
    );
  }
  const codexEntry = JSON.parse(
    run(["codex", "mcp", "get", "papertrail", "--json"], clientEnv),
  );
  expect(codexEntry.transport).toMatchObject({
    type: "stdio",
    command: realpathSync(join(installRoot, "bin", "papertrail-mcp")),
    env: { PAPERTRAIL_ROOT: dataRoot },
  });
  expect(
    run(["hermes", "mcp", "test", "papertrail"], clientEnv),
  ).toContain("search_items");
  run([join(installRoot, "current", "bin", "papertrail-enrich")], {
    PAPERTRAIL_ROOT: dataRoot,
    PAPERTRAIL_APP_ROOT: join(installRoot, "current"),
  });
  expect(JSON.parse(run([pt, "capture", "Clean install note about fault tolerant consensus"]))).toMatchObject({
    status: "queued",
    kind: "note",
  });
  run([daemon], { PAPERTRAIL_ROOT: dataRoot, PAPERTRAIL_APP_ROOT: join(installRoot, "current") });
  expect(git(dataRoot, "log", "-1", "--pretty=%s")).toBe("daemon: drain 1 capture");
  const health = run([pt, "health"]);
  expect(health).toContain("worker_inbox\tDISABLED");
  expect(health).toContain("job:daemon\tok");
  const recent = run([pt, "recent"]);
  const itemId = recent.split("\t")[0]!;
  expect(itemId).toMatch(/^pt_[a-z0-9]{10}$/);
  const canonicalPath = [...new Bun.Glob("items/**/*.md").scanSync({ cwd: dataRoot })][0]!;
  const canonicalBefore = readFileSync(join(dataRoot, canonicalPath));
  for (const member of ["papertrail.db", "papertrail.db-wal", "papertrail.db-shm", "inbox", "logs"]) {
    expect(existsSync(join(installRoot, "current", member))).toBe(false);
  }

  const fixtureDb = openDb(dataRoot);
  const legacy = ingestCapture(dataRoot, fixtureDb, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/upgrade-fixture",
    text: "Preserved captured context.",
    capturedAt: "2026-07-01T12:00:00.000Z",
  }).item;
  recordFetchResult(
    dataRoot,
    fixtureDb,
    legacy.id,
    { bodyMd: "Immutable body carried through the source upgrade." },
    3,
  );
  appendHighlight(
    dataRoot,
    fixtureDb,
    legacy.id,
    "manual",
    "Immutable body",
    "2026-07-01T12:01:00.000Z",
  );
  fixtureDb.close();
  run(["git", "add", "--", legacy.mdPath], {
    GIT_DIR: join(dataRoot, ".git"),
    GIT_WORK_TREE: dataRoot,
  });
  run(["git", "commit", "--no-gpg-sign", "-qm", "seed previous-version fixture", "--", legacy.mdPath], {
    GIT_DIR: join(dataRoot, ".git"),
    GIT_WORK_TREE: dataRoot,
  });
  const legacyBefore = readFileSync(join(dataRoot, legacy.mdPath));

  const searched = await mcpSearch(mcp, dataRoot, "fault tolerant consensus");
  expect(searched.structuredContent).toMatchObject({
    operation: "search",
    count: 1,
    hits: [{ id: itemId, bodyAvailable: false, matchField: "context" }],
  });
  expect(git(dataRoot, "status", "--short", "--", "items")).toBe("");
  expect(readFileSync(join(dataRoot, canonicalPath))).toEqual(canonicalBefore);

  const dbPath = join(dataRoot, "papertrail.db");
  rmSync(dbPath, { force: true });
  run([pt, "rebuild"]);
  expect(run([pt, "recent"])).toContain(itemId);
  expect(readFileSync(join(dataRoot, canonicalPath))).toEqual(canonicalBefore);

  const phoneHome = join(temp, "phone-home");
  const phoneEnv = { HOME: phoneHome };
  const workerReadyConfig = JSON.parse(readFileSync(configPath, "utf8"));
  workerReadyConfig.capabilities.workerInbox = true;
  workerReadyConfig.worker = {
    baseUrl: "https://worker.example",
    secret: "package-test-admin-secret",
  };
  writeFileSync(
    configPath,
    JSON.stringify(workerReadyConfig, null, 2) + "\n",
  );
  const legacyDocuments = join(temp, "legacy-icloud-documents");
  const legacyShortcut = join(temp, "Papertrail-legacy.shortcut");
  mkdirSync(legacyDocuments);
  writeFileSync(legacyShortcut, "historical iCloud Shortcut fixture");
  const legacyCapture = configureIphoneCapture({
    dataRoot,
    iCloudDocuments: legacyDocuments,
    shortcutArtifact: legacyShortcut,
  });
  const legacyQueue = join(
    legacyCapture.inboxDir,
    "papertrail-link-0.3.7-123456789-987654321.txt",
  );
  const legacyQueueBytes = Buffer.from(JSON.stringify({
    kind: "save",
    url: "https://example.com/preserved-legacy-queue",
    buildMarker: "papertrail-link-0.3.7",
  }) + "\n");
  writeFileSync(legacyQueue, legacyQueueBytes);
  await configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact: realpathSync(join(installRoot, "current", shortcutMember)),
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "package-test-capture-secret",
    fetchFn: captureOnlyFetch,
  });
  const shortcutDigest = createHash("sha256").update(sourceShortcut).digest("hex");
  expect(run([
    papertrail,
    "iphone",
    "shortcut",
    "approve",
  ], phoneEnv)).toContain(
    shortcutDigest,
  );
  expect(JSON.parse(run([papertrail, "iphone", "status"], phoneEnv))).toMatchObject({
    state: "ready",
    shortcut: "approved",
    offerQualification: "owner_qualified",
    worker: "capture_only_verified",
    liveDevice: "unknown",
    legacyIcloud: { state: "ready", queue: "queued", queuedFiles: 1 },
  });
  const iphoneConfig = JSON.parse(readFileSync(configPath, "utf8"));
  expect(iphoneConfig).toMatchObject({
    capabilities: { icloudInbox: true, workerInbox: true },
    worker: {
      baseUrl: "https://worker.example",
      secret: "package-test-admin-secret",
    },
    iphoneOnline: {
      offeredShortcut: {
        file: "Save to Papertrail — Online.shortcut",
        sha256: shortcutDigest,
      },
      approvedShortcut: {
        file: "Save to Papertrail — Online.shortcut",
        sha256: shortcutDigest,
      },
      workerVerification: {
        baseUrl: "https://worker.example",
        credential: {
          kind: "keychain",
          account: "recipient",
          service: "papertrail-capture-secret",
        },
      },
    },
  });
  expect(readFileSync(configPath, "utf8")).not.toContain(
    "package-test-capture-secret",
  );
  const configuredIphoneConfig = readFileSync(configPath, "utf8");

  const secondInstall = join(temp, "install-two");
  const secondData = join(temp, "data-two");
  lifecycleJson("install", handoffArtifact, secondInstall, secondData);
  const isolated = await mcpSearch(
    join(secondInstall, "current", "bin", "papertrail-mcp"),
    secondData,
    "fault tolerant consensus",
  );
  expect(isolated.structuredContent).toMatchObject({ count: 0, hits: [] });

  const commitsBefore = git(dataRoot, "rev-list", "--count", "HEAD");
  const repeated = lifecycleJson("install", handoffArtifact, installRoot, dataRoot);
  expect(repeated.activeRelease).toBe(first.activeRelease);
  expect(git(dataRoot, "rev-list", "--count", "HEAD")).toBe(commitsBefore);
  expect(readFileSync(configPath, "utf8")).toBe(configuredIphoneConfig);
  expect(readFileSync(legacyQueue)).toEqual(legacyQueueBytes);

  const configuredBeforeUpdate = readFileSync(configPath);
  const updateArtifact = join(temp, "artifact-v2");
  forkArtifact(handoffArtifact, updateArtifact, true);
  const failedUpdate = lifecycle(
    "update",
    updateArtifact,
    installRoot,
    undefined,
    { PAPERTRAIL_TEST_FAIL_AFTER_STAGE: "1" },
  );
  expect(failedUpdate.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(failedUpdate.stderr)).toContain(
    "simulated update failure",
  );
  expect(run([pt, "recent"])).toContain(itemId);
  expect(readFileSync(configPath)).toEqual(configuredBeforeUpdate);
  expect(readFileSync(legacyQueue)).toEqual(legacyQueueBytes);
  const refreshFailed = lifecycleJson(
    "update",
    updateArtifact,
    installRoot,
    undefined,
    { PAPERTRAIL_TEST_FAIL_SHORTCUT_REFRESH: "1" },
  );
  expect(refreshFailed.activeRelease).not.toBe(first.activeRelease);
  expect(refreshFailed.shortcutOffer).toBe("repair_required");
  expect(readFileSync(configPath)).toEqual(configuredBeforeUpdate);
  expect(readFileSync(legacyQueue)).toEqual(legacyQueueBytes);
  expect(JSON.parse(run([papertrail, "iphone", "status"], phoneEnv))).toMatchObject({
    shortcut: "repair_required",
  });

  const updated = lifecycleJson("update", updateArtifact, installRoot);
  expect(updated.activeRelease).toBe(refreshFailed.activeRelease);
  expect(updated.changed).toBe(false);
  expect(updated.shortcutOffer).toBe("updated");
  expect(readFileSync(configPath)).not.toEqual(configuredBeforeUpdate);
  expect(JSON.parse(run([papertrail, "iphone", "status"], phoneEnv))).toMatchObject({
    shortcut: "update_available",
  });
  run([
    papertrail,
    "iphone",
    "shortcut",
    "approve",
  ], phoneEnv);
  expect(JSON.parse(run([papertrail, "iphone", "status"], phoneEnv))).toMatchObject({
    shortcut: "approved",
  });
  expect(readFileSync(join(dataRoot, canonicalPath))).toEqual(canonicalBefore);
  expect(readFileSync(join(dataRoot, legacy.mdPath))).toEqual(legacyBefore);
  expect(readFileSync(legacyQueue)).toEqual(legacyQueueBytes);

  expect(run([papertrail, "iphone", "disable"], phoneEnv)).toContain(
    "reference was removed",
  );
  expect(JSON.parse(run([papertrail, "iphone", "status"], phoneEnv))).toMatchObject({
    state: "disabled",
    worker: "unconfigured",
    legacyIcloud: { state: "ready", queue: "queued", queuedFiles: 1 },
  });
  expect(readFileSync(legacyQueue)).toEqual(legacyQueueBytes);
  await configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact: realpathSync(join(installRoot, "current", shortcutMember)),
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "package-test-capture-secret-v2",
    fetchFn: captureOnlyFetch,
  });
  run([
    papertrail,
    "iphone",
    "shortcut",
    "approve",
  ], phoneEnv);
  const configBeforeUninstall = readFileSync(configPath, "utf8");
  const uninstall = lifecycleJson(
    "uninstall",
    updateArtifact,
    installRoot,
    undefined,
    clientEnv,
  );
  expect(uninstall.dataRoot).toBe(realpathSync(dataRoot));
  expect(existsSync(pt)).toBe(false);
  expect(
    Bun.spawnSync(["codex", "mcp", "get", "papertrail", "--json"], {
      env: clientEnv,
    }).exitCode,
  ).not.toBe(0);
  expect(
    run(["hermes", "mcp", "list"], clientEnv),
  ).not.toMatch(/\bpapertrail\b/i);
  expect(existsSync(join(hermesHome, "skills", "papertrail", "SKILL.md"))).toBe(false);
  expect(readFileSync(configPath, "utf8")).toBe(configBeforeUninstall);
  expect(readFileSync(join(dataRoot, canonicalPath))).toEqual(canonicalBefore);
  expect(readFileSync(join(dataRoot, legacy.mdPath))).toEqual(legacyBefore);
  expect(readFileSync(legacyQueue)).toEqual(legacyQueueBytes);
  const reinstallArtifact = join(temp, "artifact-v3");
  forkArtifact(updateArtifact, reinstallArtifact, true);
  const reinstalled = lifecycleJson("install", reinstallArtifact, installRoot, dataRoot);
  expect(reinstalled.shortcutOffer).toBe("updated");
  expect(JSON.parse(run([join(installRoot, "bin", "papertrail"), "iphone", "status"], phoneEnv)))
    .toMatchObject({
      shortcut: "update_available",
      legacyIcloud: { state: "ready", queue: "queued", queuedFiles: 1 },
    });
  expect(run([join(installRoot, "bin", "pt"), "recent"])).toContain(itemId);
  expect(readFileSync(legacyQueue)).toEqual(legacyQueueBytes);
}, 240_000);
