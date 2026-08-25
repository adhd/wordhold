import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  artifactReleaseId,
  buildDistribution,
  type ArtifactManifest,
  verifyDistributionArtifact,
} from "../scripts/build-distribution.ts";
import {
  reconcileLaunchAgentFilesForTest,
  renderLaunchAgents,
} from "../scripts/install-launchd.ts";

let scratch: string;
let artifact: string;
let updateArtifact: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "pt-guided-setup-"));
  const suppliedArtifact = process.env.WORDHOLD_RELEASE_ARTIFACT;
  artifact = suppliedArtifact
    ? realpathSync(suppliedArtifact)
    : buildDistribution(join(import.meta.dir, ".."), join(scratch, "Downloaded Wordhold"));
  verifyDistributionArtifact(artifact);
  updateArtifact = join(scratch, "Downloaded Wordhold Update");
  cpSync(artifact, updateArtifact, { recursive: true });
  const readmePath = join(updateArtifact, "README.md");
  const readme = `${readFileSync(readmePath, "utf8")}\nUpdate fixture.\n`;
  writeFileSync(readmePath, readme);
  const manifestPath = join(updateArtifact, ".papertrail-artifact.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ArtifactManifest;
  manifest.files["README.md"] = createHash("sha256").update(readme).digest("hex");
  manifest.releaseId = artifactReleaseId(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}, 60_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(
  args: string[],
  env: Record<string, string> = {},
  inherit = true,
) {
  return Bun.spawnSync(args, { env: inherit ? { ...process.env, ...env } : env });
}

function ok(
  args: string[],
  env: Record<string, string> = {},
  inherit = true,
): string {
  const result = run(args, env, inherit);
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout);
}

test("one packaged command establishes and removes a usable local archive", () => {
  const home = join(scratch, "Recipient Home");
  const installRoot = join(home, "Library", "Application Support", "Papertrail", "app");
  const dataRoot = join(home, "Library", "Application Support", "Papertrail", "data");
  const minimalEnv = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    TMPDIR: scratch,
    LANG: "C",
    GIT_DIR: join(scratch, "must-not-be-used.git"),
  };
  const runtimeEnv = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    TMPDIR: scratch,
    LANG: "C",
  };
  const setup = ok([
    join(artifact, "wordhold"),
    "setup",
    "--install-root",
    installRoot,
    "--data-root",
    dataRoot,
  ], minimalEnv, false);
  expect(setup).toContain("Wordhold installed");
  expect(setup).toContain("Local archive ready");
  expect(setup).toContain("Optional integrations remain disabled");
  expect(existsSync(join(installRoot, "bin", "wordhold"))).toBe(true);
  expect(existsSync(join(installRoot, "bin", "papertrail"))).toBe(true);
  expect(existsSync(join(dataRoot, ".git"))).toBe(true);
  expect(existsSync(minimalEnv.GIT_DIR)).toBe(false);

  const wordhold = join(installRoot, "bin", "wordhold");
  const pt = join(installRoot, "bin", "pt");
  const papertrail = join(installRoot, "bin", "papertrail");
  expect(ok([wordhold, "update"], minimalEnv, false)).toContain(
    "already on this release",
  );
  const launcher = join(artifact, "wordhold");
  expect(JSON.parse(ok([
    launcher,
    "capture",
    "A recipient setup note",
    "--install-root",
    installRoot,
  ], minimalEnv, false))).toMatchObject({
    status: "queued",
  });
  ok([wordhold, "drain"], runtimeEnv, false);
  const recent = ok([wordhold, "recent"], runtimeEnv, false);
  const id = recent.split("\t")[0]!;
  expect(id).toMatch(/^pt_[a-z0-9]{10}$/);
  expect(ok([wordhold, "show", id], runtimeEnv, false)).toContain(
    "A recipient setup note",
  );
  ok([wordhold, "health"], runtimeEnv, false);
  const diagnosis = run([wordhold, "doctor"], runtimeEnv, false);
  expect(diagnosis.exitCode).toBe(1);
  expect(new TextDecoder().decode(diagnosis.stdout)).toContain(
    "WARNING\tbody_unavailable\t1",
  );
  expect(ok([
    "git",
    "log",
    "-1",
    "--format=%s",
  ], {
    ...runtimeEnv,
    GIT_DIR: join(dataRoot, ".git"),
    GIT_WORK_TREE: dataRoot,
  }, false)).toBe("daemon: drain 1 capture\n");
  const canonical = [...new Bun.Glob("items/**/*.md").scanSync({ cwd: dataRoot })][0]!;
  const bytes = readFileSync(join(dataRoot, canonical));
  expect(bytes.includes(Buffer.from(installRoot))).toBe(false);
  expect(ok([
    launcher,
    "recent",
    "--install-root",
    installRoot,
  ], minimalEnv, false)).toContain(id);

  rmSync(join(dataRoot, "papertrail.db"), { force: true });
  ok([wordhold, "rebuild"], runtimeEnv, false);
  expect(ok([wordhold, "recent"], runtimeEnv, false)).toContain(id);
  expect(ok([papertrail, "recent"], runtimeEnv, false)).toContain(id);
  expect(readFileSync(join(dataRoot, canonical))).toEqual(bytes);

  const launchAgents = join(home, "Library", "LaunchAgents");
  mkdirSync(launchAgents, { recursive: true });
  writeFileSync(join(launchAgents, "app.papertrail.daemon.plist"), "unreceipted\n");
  const unreceipted = run([wordhold, "uninstall"], minimalEnv, false);
  expect(unreceipted.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(unreceipted.stderr)).toContain(
    "without a Wordhold receipt",
  );
  expect(existsSync(join(installRoot, "install.json"))).toBe(true);
  rmSync(launchAgents, { recursive: true, force: true });

  const otherDataRoot = join(home, "other-papertrail-data");
  mkdirSync(otherDataRoot);
  const otherDefinitions = renderLaunchAgents({
    repoRoot: otherDataRoot,
    bunPath: "/usr/bin/false",
    enabledJobs: [],
  });
  reconcileLaunchAgentFilesForTest(otherDataRoot, launchAgents, otherDefinitions);
  const mismatched = run([wordhold, "uninstall"], minimalEnv, false);
  expect(mismatched.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(mismatched.stderr)).toContain(
    "different private data root",
  );
  expect(existsSync(join(installRoot, "install.json"))).toBe(true);
  rmSync(launchAgents, { recursive: true, force: true });

  const removed = ok([wordhold, "uninstall"], minimalEnv, false);
  expect(removed).toContain("Private data preserved");
  expect(existsSync(join(installRoot, "install.json"))).toBe(false);
  expect(readFileSync(join(dataRoot, canonical))).toEqual(bytes);

  rmSync(join(dataRoot, "papertrail.config.json"));
  const missingRestoreConfig = run([
    join(artifact, "wordhold"),
    "setup",
    "--install-root",
    installRoot,
    "--data-root",
    dataRoot,
  ], minimalEnv, false);
  expect(missingRestoreConfig.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(missingRestoreConfig.stderr)).toContain(
    "without real Wordhold config and Git markers",
  );
  cpSync(
    join(artifact, "papertrail.config.example.json"),
    join(dataRoot, "papertrail.config.json"),
  );
  chmodSync(join(dataRoot, "papertrail.config.json"), 0o600);
  expect(ok([
    join(artifact, "wordhold"),
    "setup",
    "--install-root",
    installRoot,
    "--data-root",
    dataRoot,
  ], minimalEnv, false)).toContain("Wordhold installed");
  expect(ok([
    join(installRoot, "bin", "wordhold"),
    "recent",
  ], runtimeEnv, false)).toContain(id);
  expect(ok([
    join(installRoot, "bin", "wordhold"),
    "uninstall",
  ], minimalEnv, false)).toContain("Private data preserved");
}, 120_000);

test("compiled launcher ignores ambient dotenv and bunfig preload files", () => {
  const home = join(scratch, "Ambient Config Home");
  const cwd = join(scratch, "hostile launch directory");
  const expectedInstall = join(
    home,
    "Library",
    "Application Support",
    "Papertrail",
    "app",
  );
  const hostileInstall = join(scratch, "dotenv-selected-install");
  const dataRoot = join(scratch, "ambient-config-data");
  const preloadMarker = join(scratch, "ambient-preload-ran");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, ".env"),
    `PAPERTRAIL_INSTALL_ROOT=${JSON.stringify(hostileInstall)}\n`,
  );
  writeFileSync(
    join(cwd, "hostile-preload.js"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(preloadMarker)}, "loaded\\n");\n`,
  );
  writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./hostile-preload.js"]\n');

  const result = Bun.spawnSync([
    join(artifact, "wordhold"),
    "setup",
    "--data-root",
    dataRoot,
  ], {
    cwd,
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin",
      TMPDIR: scratch,
      LANG: "C",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  expect(existsSync(join(expectedInstall, "install.json"))).toBe(true);
  expect(existsSync(hostileInstall)).toBe(false);
  expect(existsSync(preloadMarker)).toBe(false);
  expect(ok([
    join(expectedInstall, "bin", "wordhold"),
    "uninstall",
  ], {
    HOME: home,
    PATH: "/usr/bin:/bin",
    TMPDIR: scratch,
    LANG: "C",
  }, false)).toContain("Private data preserved");
}, 120_000);

test("retrying the same update repairs a failed scheduled-job reload", () => {
  const home = join(scratch, "Scheduled Update Home");
  const installRoot = join(home, "app");
  const dataRoot = join(home, "data");
  const fakeBin = join(home, "fake-bin");
  const launchctlLog = join(home, "launchctl.log");
  mkdirSync(fakeBin, { recursive: true });
  const launchctl = join(fakeBin, "launchctl");
  writeFileSync(
    launchctl,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LAUNCHCTL_LOG"
if [ "$1" = "print" ]; then exit 1; fi
if [ "$1" = "bootstrap" ] && [ "$FAKE_LAUNCHCTL_FAIL_BOOTSTRAP" = "1" ]; then exit 17; fi
exit 0
`,
  );
  chmodSync(launchctl, 0o700);
  const env = {
    HOME: home,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    TMPDIR: scratch,
    LANG: "C",
    FAKE_LAUNCHCTL_LOG: launchctlLog,
  };
  ok([
    join(artifact, "wordhold"),
    "setup",
    "--install-root",
    installRoot,
    "--data-root",
    dataRoot,
  ], env, false);
  const installed = join(installRoot, "bin", "wordhold");
  ok([installed, "schedule"], env, false);

  const failed = run([
    join(updateArtifact, "wordhold"),
    "update",
    "--install-root",
    installRoot,
  ], { ...env, FAKE_LAUNCHCTL_FAIL_BOOTSTRAP: "1" }, false);
  expect(failed.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(failed.stderr)).toContain("launchctl failed");
  const attemptsAfterFailure = readFileSync(launchctlLog, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("bootstrap ")).length;

  expect(ok([
    installed,
    "update",
    "--install-root",
    installRoot,
  ], env, false)).toContain("already on this release");
  const attemptsAfterRetry = readFileSync(launchctlLog, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("bootstrap ")).length;
  expect(attemptsAfterRetry).toBe(attemptsAfterFailure + 1);
}, 120_000);

test("a changed scheduled-job definition blocks update before release activation", () => {
  const home = join(scratch, "Changed Schedule Home");
  const installRoot = join(home, "app");
  const dataRoot = join(home, "data");
  const fakeBin = join(home, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  const launchctl = join(fakeBin, "launchctl");
  writeFileSync(
    launchctl,
    `#!/bin/sh
if [ "$1" = "print" ]; then exit 1; fi
exit 0
`,
  );
  chmodSync(launchctl, 0o700);
  const env = {
    HOME: home,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    TMPDIR: scratch,
    LANG: "C",
  };
  ok([
    join(artifact, "wordhold"),
    "setup",
    "--install-root",
    installRoot,
    "--data-root",
    dataRoot,
  ], env, false);
  const installed = join(installRoot, "bin", "wordhold");
  ok([installed, "schedule"], env, false);
  writeFileSync(
    join(home, "Library", "LaunchAgents", "app.papertrail.daemon.plist"),
    "owner-edited definition\n",
  );

  const failed = run([
    join(updateArtifact, "wordhold"),
    "update",
    "--install-root",
    installRoot,
  ], env, false);
  expect(failed.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(failed.stderr)).toContain(
    "changed or unmanaged launchd file",
  );
  const installedManifest = JSON.parse(readFileSync(
    join(installRoot, "current", ".papertrail-artifact.json"),
    "utf8",
  )) as ArtifactManifest;
  const originalManifest = JSON.parse(readFileSync(
    join(artifact, ".papertrail-artifact.json"),
    "utf8",
  )) as ArtifactManifest;
  expect(installedManifest.releaseId).toBe(originalManifest.releaseId);
}, 120_000);

test("missing Git fails before creating program or private data", () => {
  const home = join(scratch, "No Git Home");
  const installRoot = join(home, "app");
  const dataRoot = join(home, "data");
  const result = run([
    join(artifact, "wordhold"),
    "setup",
    "--install-root",
    installRoot,
    "--data-root",
    dataRoot,
  ], {
    HOME: home,
    PATH: join(scratch, "empty-path"),
    TMPDIR: scratch,
    LANG: "C",
  }, false);
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("Git is required before Wordhold setup");
  expect(existsSync(installRoot)).toBe(false);
  expect(existsSync(dataRoot)).toBe(false);
});

test("packaged commands expose the qualified online Shortcut without claiming device setup", () => {
  const home = join(scratch, "Online Shortcut Home");
  const installRoot = join(home, "app");
  const dataRoot = join(home, "data");
  const env = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    TMPDIR: scratch,
    LANG: "C",
  };
  ok([
    join(artifact, "wordhold"),
    "setup",
    "--install-root",
    installRoot,
    "--data-root",
    dataRoot,
  ], env, false);
  const papertrail = join(installRoot, "bin", "papertrail");
  const status = JSON.parse(ok([papertrail, "iphone", "status"], env, false));
  expect(status).toMatchObject({
    state: "disabled",
    shortcut: "approval_required",
    worker: "unconfigured",
    offerQualification: "owner_qualified",
    offerVersion: "0.4.0",
    workflowName: "Save to Papertrail — Online",
    liveDevice: "unknown",
    legacyIcloud: { state: "disabled" },
  });
  expect(existsSync(join(
    installRoot,
    "current",
    "integrations",
    "shortcuts",
    "Save to Papertrail — Online.shortcut",
  ))).toBe(true);

  const setup = run([papertrail, "iphone", "setup"], env, false);
  expect(setup.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(setup.stderr)).toContain(
    "requires --base-url and --keychain-account",
  );

  const copy = run([
    papertrail,
    "iphone",
    "shortcut",
    "copy-token",
  ], env, false);
  expect(copy.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(copy.stderr)).toContain(
    "configure online iPhone capture first",
  );
}, 120_000);

test("guided Codex and Hermes setup use the same packaged six-tool server", async () => {
  const home = join(scratch, "Agent Recipient Home");
  const installRoot = join(home, "app");
  const dataRoot = join(home, "data");
  const codexHome = join(home, "codex");
  const hermesHome = join(home, "hermes");
  const env = {
    ...process.env,
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    CODEX_HOME: codexHome,
    HERMES_HOME: hermesHome,
  };
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(hermesHome, { recursive: true });
  ok([
    join(artifact, "wordhold"),
    "setup",
    "--install-root",
    installRoot,
    "--data-root",
    dataRoot,
  ], env);
  const pt = join(installRoot, "bin", "pt");
  const guided = join(installRoot, "bin", "papertrail");
  ok([pt, "capture", "Agent onboarding evidence about bounded retrieval"], env);
  ok([guided, "drain"], env);

  expect(run(
    ["codex", "mcp", "add", "unrelated", "--", "/usr/bin/true"],
    env,
  ).exitCode).toBe(0);
  expect(Bun.spawnSync(
    ["hermes", "mcp", "add", "unrelated", "--command", "/usr/bin/true"],
    { env, stdin: new TextEncoder().encode("y\n") },
  ).exitCode).toBe(0);

  for (const selected of ["codex", "hermes"] as const) {
    expect(ok([guided, "connect", selected], env)).toContain(
      `Wordhold connected to ${selected}`,
    );
    const receipt = JSON.parse(
      readFileSync(join(installRoot, "agent-integrations.json"), "utf8"),
    );
    const expected = receipt.managed[selected].expected as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    const client = new Client({ name: "guided-agent-proof", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: expected.command,
      args: expected.args,
      env: { PATH: env.PATH ?? "", ...expected.env },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toMatchObject({
        name: "wordhold",
        version: "0.5.0",
      });
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "doctor",
        "get_item",
        "health",
        "queue_capture",
        "recent_items",
        "search_items",
      ]);
      const search = await client.callTool({
        name: "search_items",
        arguments: { query: "bounded retrieval" },
      });
      expect(search.structuredContent).toMatchObject({ count: 1 });
      const id = (search.structuredContent as { hits: Array<{ id: string }> }).hits[0]!.id;
      expect((await client.callTool({
        name: "get_item",
        arguments: { id, maxChars: 500 },
      })).structuredContent).toMatchObject({ item: { id } });
      expect((await client.callTool({
        name: "queue_capture",
        arguments: {
          input: `Deliberate ${selected} queued note`,
          intent: "note",
        },
      })).structuredContent).toMatchObject({
        operation: "capture",
        status: "queued",
        kind: "note",
      });
    } finally {
      await client.close();
    }
    expect(ok([guided, "disconnect", selected], env)).toContain(
      `disconnected from ${selected}`,
    );
  }

  expect(run(["codex", "mcp", "get", "unrelated", "--json"], env).exitCode).toBe(0);
  expect(ok(["hermes", "mcp", "list"], env)).toContain("unrelated");
  expect(existsSync(join(dataRoot, ".git"))).toBe(true);
  ok([guided, "uninstall"], env);
}, 120_000);
