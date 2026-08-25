import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  installLaunchAgents,
  reconcileLaunchAgentFilesForTest,
  renderLaunchAgents,
  syncPackagedDaemon,
  uninstallLaunchAgents,
} from "../scripts/install-launchd.ts";

test("launchd definitions use a stable daemon binary and bounded schedules", async () => {
  const files = renderLaunchAgents({
    repoRoot: "/Users/test/Projects/papertrail",
    bunPath: "/opt/homebrew/bin/bun",
  });
  expect(Object.keys(files).sort()).toEqual([
    "app.papertrail.daemon.plist",
    "app.papertrail.digest.plist",
    "app.papertrail.enrich.plist",
    "app.papertrail.resurface.plist",
  ]);
  const daemon = files["app.papertrail.daemon.plist"];
  expect(daemon).toContain("/Users/test/Projects/papertrail/dist/papertrail-daemon");
  expect(daemon).toContain("<key>StartInterval</key>\n    <integer>300</integer>");
  expect(daemon).not.toContain("/opt/homebrew/bin/bun");

  const enrich = files["app.papertrail.enrich.plist"];
  expect(enrich).toContain("/opt/homebrew/bin/bun");
  expect(enrich).toContain("/Users/test/Projects/papertrail/agent/enrich.ts");
  expect(enrich).toContain("<key>Hour</key><integer>2</integer>");
  expect(files["app.papertrail.digest.plist"]).toContain(
    "<key>Weekday</key><integer>1</integer>",
  );
  expect(files["app.papertrail.resurface.plist"]).toContain(
    "/Users/test/Projects/papertrail/daemon/resurface.ts",
  );
  for (const plist of Object.values(files)) {
    expect(plist).toContain("<key>PAPERTRAIL_ROOT</key>");
    expect(plist).toContain("<key>PAPERTRAIL_APP_ROOT</key>");
    expect(plist).toContain("<string>/Users/test/Projects/papertrail</string>");
    expect(plist).toContain("<key>Umask</key>\n  <integer>63</integer>");
    expect(plist).toContain("/Users/test/Projects/papertrail/logs/");
    const lint = Bun.spawn(["plutil", "-lint", "-"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    lint.stdin.write(plist);
    lint.stdin.end();
    expect(await lint.exited).toBe(0);
  }
});

test("launchd XML escapes paths instead of producing malformed plists", () => {
  const files = renderLaunchAgents({
    repoRoot: "/tmp/Paper & Trail",
    bunPath: "/tmp/Bun > current",
  });
  expect(files["app.papertrail.enrich.plist"]).toContain(
    "/tmp/Paper &amp; Trail/agent/enrich.ts",
  );
  expect(files["app.papertrail.enrich.plist"]).toContain(
    "/tmp/Bun &gt; current",
  );
});

test("local-only launchd rendering installs no optional schedules", () => {
  const files = renderLaunchAgents({
    repoRoot: "/Users/test/Papertrail data",
    appRoot: "/Applications/Papertrail source",
    bunPath: "/opt/homebrew/bin/bun",
    enabledJobs: [],
  });
  expect(Object.keys(files)).toEqual(["app.papertrail.daemon.plist"]);
  expect(files["app.papertrail.daemon.plist"]).toContain(
    "<key>PAPERTRAIL_APP_ROOT</key>\n    <string>/Applications/Papertrail source</string>",
  );
});

test("stable daemon keeps its inode when packaged bytes are unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-stable-daemon-"));
  try {
    const packaged = join(root, "packaged");
    const installed = join(root, "installed");
    writeFileSync(packaged, "same daemon bytes\n");
    writeFileSync(installed, "same daemon bytes\n");
    const inode = statSync(installed).ino;

    expect(syncPackagedDaemon(packaged, installed)).toBe("preserved");
    expect(statSync(installed).ino).toBe(inode);
    expect(statSync(installed).mode & 0o777).toBe(0o700);

    writeFileSync(packaged, "new daemon bytes\n");
    const priorInode = statSync(installed).ino;
    expect(syncPackagedDaemon(packaged, installed)).toBe("replaced");
    expect(statSync(installed).ino).not.toBe(priorInode);
    expect(readFileSync(installed, "utf8")).toBe("new daemon bytes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stable daemon synchronization refuses symlink boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-stable-daemon-link-"));
  try {
    const packaged = join(root, "packaged");
    const external = join(root, "external");
    const installed = join(root, "installed");
    writeFileSync(packaged, "daemon bytes\n");
    writeFileSync(external, "daemon bytes\n");
    const externalMode = statSync(external).mode & 0o777;
    symlinkSync(external, installed);

    expect(() => syncPackagedDaemon(packaged, installed)).toThrow(
      "stable daemon must be a real file",
    );
    expect(readFileSync(external, "utf8")).toBe("daemon bytes\n");
    expect(statSync(external).mode & 0o777).toBe(externalMode);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launchd uninstall removes only recognizable Papertrail definitions", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-launchd-remove-"));
  try {
    const rendered = renderLaunchAgents({
      repoRoot: "/tmp/Papertrail data",
      bunPath: "/opt/homebrew/bin/bun",
    });
    reconcileLaunchAgentFilesForTest("/tmp/Papertrail data", root, rendered);
    const changed = join(root, "app.papertrail.digest.plist");
    writeFileSync(changed, readFileSync(changed, "utf8").replace("daemon/digest.ts", "different-command.ts"));
    await expect(uninstallLaunchAgents(root, "app.papertrail", false)).rejects.toThrow(
      "refusing to replace changed or unmanaged launchd file",
    );
    expect(existsSync(join(root, "app.papertrail.daemon.plist"))).toBe(true);

    writeFileSync(changed, rendered["app.papertrail.digest.plist"]!);
    const removed = await uninstallLaunchAgents(root, "app.papertrail", false);
    expect(removed).toHaveLength(4);
    for (const path of removed) expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launchd reconciliation removes an owned schedule when capability is disabled", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-launchd-converge-"));
  try {
    const all = renderLaunchAgents({
      repoRoot: "/tmp/Papertrail data",
      bunPath: "/opt/homebrew/bin/bun",
    });
    reconcileLaunchAgentFilesForTest("/tmp/Papertrail data", root, all);
    const localOnly = renderLaunchAgents({
      repoRoot: "/tmp/Papertrail data",
      bunPath: "/opt/homebrew/bin/bun",
      enabledJobs: [],
    });
    reconcileLaunchAgentFilesForTest("/tmp/Papertrail data", root, localOnly);
    expect(existsSync(join(root, "app.papertrail.daemon.plist"))).toBe(true);
    expect(existsSync(join(root, "app.papertrail.digest.plist"))).toBe(false);
    expect(existsSync(join(root, "app.papertrail.enrich.plist"))).toBe(false);
    expect(existsSync(join(root, "app.papertrail.resurface.plist"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launchd reconciliation retries exact interrupted old-to-new file states", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-launchd-retry-"));
  try {
    const repoRoot = "/tmp/Papertrail retry data";
    const prior = renderLaunchAgents({
      repoRoot,
      bunPath: "/opt/homebrew/bin/bun-old",
    });
    reconcileLaunchAgentFilesForTest(repoRoot, root, prior);

    const desired = renderLaunchAgents({
      repoRoot,
      bunPath: "/opt/homebrew/bin/bun-new",
    });
    writeFileSync(
      join(root, "app.papertrail.enrich.plist"),
      desired["app.papertrail.enrich.plist"]!,
    );
    expect(() => reconcileLaunchAgentFilesForTest(repoRoot, root, desired))
      .not.toThrow();

    unlinkSync(join(root, "app.papertrail.digest.plist"));
    const localOnly = renderLaunchAgents({
      repoRoot,
      bunPath: "/opt/homebrew/bin/bun-new",
      enabledJobs: [],
    });
    expect(() => reconcileLaunchAgentFilesForTest(repoRoot, root, localOnly))
      .not.toThrow();
    expect(existsSync(join(root, "app.papertrail.daemon.plist"))).toBe(true);
    expect(existsSync(join(root, "app.papertrail.enrich.plist"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launchd uninstall preserves a file when bootout genuinely fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-launchd-bootout-"));
  try {
    const rendered = renderLaunchAgents({
      repoRoot: "/tmp/Papertrail data",
      bunPath: "/opt/homebrew/bin/bun",
      enabledJobs: [],
    });
    reconcileLaunchAgentFilesForTest("/tmp/Papertrail data", root, rendered);
    const runner = (args: string[]): number => args[0] === "print" ? 0 : 1;
    await expect(uninstallLaunchAgents(root, "app.papertrail", true, runner))
      .rejects.toThrow(/bootout failed/);
    expect(existsSync(join(root, "app.papertrail.daemon.plist"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launchd ownership refusal happens before replacing the daemon", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-launchd-preflight-"));
  try {
    const dataRoot = join(root, "data");
    const destination = join(root, "LaunchAgents");
    const appRoot = join(root, "app");
    mkdirSync(join(dataRoot, "dist"), { recursive: true });
    writeFileSync(
      join(dataRoot, "papertrail.config.json"),
      JSON.stringify({
        worker: { baseUrl: "", secret: "" },
        icloudInboxDir: "",
        readingListPlist: "",
        imessage: { recipient: "", dryRun: true },
        enrichment: { minBodyChars: 600, maxFetchAttempts: 5 },
      }),
    );
    mkdirSync(destination, { recursive: true });
    mkdirSync(join(appRoot, "bin"), { recursive: true });
    const installedDaemon = join(dataRoot, "dist", "papertrail-daemon");
    writeFileSync(installedDaemon, "operator daemon\n");
    writeFileSync(join(appRoot, "bin", "papertrail-daemon"), "replacement daemon\n");
    writeFileSync(
      join(destination, "app.papertrail.daemon.plist"),
      "operator-managed plist\n",
    );

    await expect(installLaunchAgents(dataRoot, destination, appRoot)).rejects.toThrow(
      /changed or unmanaged launchd file/,
    );
    expect(readFileSync(installedDaemon, "utf8")).toBe("operator daemon\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the compiled daemon starts in a fresh launchd-style corpus", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-compiled-daemon-"));
  try {
    const sourceRoot = join(import.meta.dir, "..");
    const binary = join(root, "papertrail-daemon");
    mkdirSync(join(root, "icloud"));
    writeFileSync(
      join(root, "papertrail.config.json"),
      JSON.stringify({
        worker: { baseUrl: "", secret: "" },
        icloudInboxDir: join(root, "icloud"),
        readingListPlist: join(root, "missing-Bookmarks.plist"),
        imessage: { recipient: "test", dryRun: true },
        enrichment: { minBodyChars: 100, maxFetchAttempts: 3 },
      }),
    );
    writeFileSync(join(root, ".gitignore"), "papertrail.db*\ninbox/\nlogs/\n");
    writeFileSync(join(root, "README.md"), "temporary corpus\n");
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "Papertrail Test"],
      ["config", "user.email", "papertrail@example.invalid"],
      ["config", "commit.gpgsign", "false"],
      ["add", ".gitignore", "README.md", "papertrail.config.json"],
      ["commit", "-qm", "baseline"],
    ]) {
      const git = Bun.spawnSync(["git", ...args], { cwd: root });
      if (git.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(git.stderr));
      }
    }

    const compile = Bun.spawnSync(
      [
        "bun",
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--reject-unresolved",
        "daemon/main.ts",
        "--outfile",
        binary,
      ],
      { cwd: sourceRoot },
    );
    if (compile.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(compile.stderr));
    }
    const run = Bun.spawnSync([binary], {
      cwd: root,
      env: {
        ...process.env,
        PAPERTRAIL_ROOT: root,
        PAPERTRAIL_DRY_RUN: "1",
      },
    });
    if (run.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(run.stderr));
    }

    expect(existsSync(join(root, "papertrail.db"))).toBe(true);
    const db = new Database(join(root, "papertrail.db"), { readonly: true });
    expect(
      db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'items'")
        .get(),
    ).toEqual({ count: 1 });
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
