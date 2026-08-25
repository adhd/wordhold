import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { artifactReleaseId } from "../scripts/build-distribution.ts";
import { initializeDataRoot } from "../core/installation.ts";
import {
  installOrUpdate,
  installedDataRoot,
  uninstallProgram,
} from "../scripts/lifecycle.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): { root: string; artifact: string } {
  const root = mkdtempSync(join(tmpdir(), "pt-lifecycle-safety-"));
  roots.push(root);
  const artifact = join(root, "artifact");
  mkdirSync(artifact);
  const readme = "Papertrail lifecycle fixture\n";
  writeFileSync(join(artifact, "README.md"), readme);
  const executables = [
    "papertrail",
    "bin/papertrail-daemon",
    "bin/papertrail-digest",
    "bin/papertrail-enrich",
    "bin/papertrail-mcp",
    "bin/papertrail-resurface",
    "bin/pt",
  ];
  const files: Record<string, string> = {
    "README.md": createHash("sha256").update(readme).digest("hex"),
  };
  mkdirSync(join(artifact, "bin"));
  for (const path of executables) {
    const bytes = `#!/bin/sh\n# ${path}\n`;
    writeFileSync(join(artifact, path), bytes, { mode: 0o700 });
    chmodSync(join(artifact, path), 0o700);
    files[path] = createHash("sha256").update(bytes).digest("hex");
  }
  const base = {
    format: 3 as const,
    product: "papertrail" as const,
    version: "0.1.0-test",
    source: { revision: "0".repeat(40), dirty: false },
    build: {
      platform: process.platform,
      arch: process.arch,
      bunVersion: Bun.version,
    },
    executables,
    runtime: {
      externalCommands: ["git"],
      bundledRuntime: { name: "bun" as const, version: Bun.version },
      directPackages: {},
    },
    signing: { kind: "adhoc" as const, verified: true as const },
    files,
  };
  writeFileSync(
    join(artifact, ".papertrail-artifact.json"),
    JSON.stringify({ ...base, releaseId: artifactReleaseId(base) }) + "\n",
  );
  return { root, artifact };
}

function wordholdArtifact(root: string, papertrailArtifact: string): string {
  const artifact = join(root, "wordhold-artifact");
  cpSync(papertrailArtifact, artifact, { recursive: true });
  cpSync(join(artifact, "papertrail"), join(artifact, "wordhold"));
  chmodSync(join(artifact, "wordhold"), 0o700);
  const manifestPath = join(artifact, ".papertrail-artifact.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.format = 4;
  manifest.version = "0.5.0-test";
  manifest.executables = ["wordhold", ...manifest.executables];
  manifest.files.wordhold = createHash("sha256")
    .update(readFileSync(join(artifact, "wordhold")))
    .digest("hex");
  manifest.releaseId = artifactReleaseId(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest) + "\n");
  return artifact;
}

test("program and private-data roots must not contain one another", () => {
  const { root, artifact } = fixture();
  expect(() =>
    installOrUpdate({
      sourceRoot: artifact,
      installRoot: join(root, "program"),
      dataRoot: join(root, "program", "data"),
    })
  ).toThrow("program and private data roots must be separate");
  expect(() =>
    installOrUpdate({
      sourceRoot: artifact,
      installRoot: join(root, "data", "program"),
      dataRoot: join(root, "data"),
    })
  ).toThrow("program and private data roots must be separate");
});

test("first install refuses a nonempty unrelated target before data initialization", () => {
  const { root, artifact } = fixture();
  const installRoot = join(root, "existing-programs");
  const dataRoot = join(root, "new-private-data");
  mkdirSync(installRoot);
  writeFileSync(join(installRoot, "keep.txt"), "unrelated operator file\n");

  expect(() => installOrUpdate({ sourceRoot: artifact, installRoot, dataRoot }))
    .toThrow("refusing to install into a nonempty directory without a valid Wordhold receipt");
  expect(existsSync(dataRoot)).toBe(false);
});

test("lifecycle roots cannot be existing symlink aliases", () => {
  const { root, artifact } = fixture();
  const actualInstall = join(root, "actual-install");
  const installAlias = join(root, "install-alias");
  const dataRoot = join(root, "private-data");
  mkdirSync(actualInstall);
  symlinkSync(actualInstall, installAlias);

  expect(() =>
    installOrUpdate({ sourceRoot: artifact, installRoot: installAlias, dataRoot })
  ).toThrow("lifecycle roots cannot be symbolic links");
  expect(existsSync(dataRoot)).toBe(false);

  const realParent = join(root, "real-parent");
  const parentAlias = join(root, "parent-alias");
  mkdirSync(realParent);
  symlinkSync(realParent, parentAlias);
  expect(() =>
    installOrUpdate({
      sourceRoot: artifact,
      installRoot: join(parentAlias, "app"),
      dataRoot: join(realParent, "app", "data"),
    })
  ).toThrow("program and private data roots must be separate");
  expect(existsSync(join(realParent, "app"))).toBe(false);
});

test("filesystem root and the user's home are never lifecycle targets", () => {
  const { root, artifact } = fixture();
  expect(() =>
    installOrUpdate({
      sourceRoot: artifact,
      installRoot: "/",
      dataRoot: join(root, "data"),
    })
  ).toThrow("refusing broad lifecycle root");
  expect(() =>
    installOrUpdate({
      sourceRoot: artifact,
      installRoot: join(root, "app"),
      dataRoot: homedir(),
    })
  ).toThrow("refusing broad lifecycle root");
  expect(() => uninstallProgram("/")).toThrow("refusing broad lifecycle root");
  expect(() => uninstallProgram(homedir())).toThrow("refusing broad lifecycle root");
});

test("update without a data-root uses the valid receipt's recorded corpus", () => {
  const { root, artifact } = fixture();
  const installRoot = join(root, "app");
  const dataRoot = join(root, "data");
  const first = installOrUpdate({ sourceRoot: artifact, installRoot, dataRoot });

  const repeated = installOrUpdate({ sourceRoot: artifact, installRoot });
  expect(repeated.dataRoot).toBe(realpathSync(dataRoot));
  expect(repeated.activeRelease).toBe(first.activeRelease);
});

test("Wordhold upgrades a Papertrail install in place and retains both command names", () => {
  const { root, artifact } = fixture();
  const installRoot = join(root, "app");
  const dataRoot = join(root, "data");
  installOrUpdate({ sourceRoot: artifact, installRoot, dataRoot });
  const configBefore = readFileSync(join(dataRoot, "papertrail.config.json"));
  const headBefore = new TextDecoder().decode(
    Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dataRoot }).stdout,
  ).trim();
  mkdirSync(join(dataRoot, "items"), { recursive: true });
  const sentinel = join(dataRoot, "items", "legacy-proof.md");
  writeFileSync(sentinel, "legacy corpus bytes remain in place\n");
  const sentinelBefore = readFileSync(sentinel);

  const update = installOrUpdate({
    sourceRoot: wordholdArtifact(root, artifact),
    installRoot,
  });

  expect(update.dataRoot).toBe(realpathSync(dataRoot));
  expect(readFileSync(join(dataRoot, "papertrail.config.json"))).toEqual(configBefore);
  expect(readFileSync(sentinel)).toEqual(sentinelBefore);
  expect(new TextDecoder().decode(
    Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dataRoot }).stdout,
  ).trim()).toBe(headBefore);
  expect(existsSync(join(dataRoot, "wordhold.config.json"))).toBe(false);
  expect(existsSync(join(dataRoot, "wordhold.db"))).toBe(false);
  for (const command of ["wordhold", "papertrail", "pt"]) {
    const path = join(installRoot, "bin", command);
    expect(existsSync(path)).toBe(true);
    expect(Bun.spawnSync([path]).exitCode).toBe(0);
  }
  expect(JSON.parse(readFileSync(join(installRoot, "install.json"), "utf8")))
    .toMatchObject({ product: "papertrail", dataRoot: realpathSync(dataRoot) });
});

test("a Wordhold install refuses a Papertrail artifact downgrade without split wrappers", () => {
  const { root, artifact } = fixture();
  const installRoot = join(root, "app");
  const dataRoot = join(root, "data");
  installOrUpdate({
    sourceRoot: wordholdArtifact(root, artifact),
    installRoot,
    dataRoot,
  });
  const currentBefore = readlinkSync(join(installRoot, "current"));
  const receiptBefore = readFileSync(join(installRoot, "install.json"));
  const wordholdBefore = readFileSync(join(installRoot, "bin", "wordhold"));

  expect(() => installOrUpdate({ sourceRoot: artifact, installRoot }))
    .toThrow("refusing to activate an older artifact format over this Wordhold installation");
  expect(readlinkSync(join(installRoot, "current"))).toBe(currentBefore);
  expect(readFileSync(join(installRoot, "install.json"))).toEqual(receiptBefore);
  expect(readFileSync(join(installRoot, "bin", "wordhold"))).toEqual(wordholdBefore);
});

test("an interrupted Papertrail-to-Wordhold wrapper migration is retryable", () => {
  for (const failure of [4, "receipt"] as const) {
    const { root, artifact } = fixture();
    const installRoot = join(root, "app");
    const dataRoot = join(root, "data");
    const installed = installOrUpdate({ sourceRoot: artifact, installRoot, dataRoot });
    const configBefore = readFileSync(join(dataRoot, "papertrail.config.json"));
    const sentinel = join(dataRoot, "agent", `rename-${failure}.txt`);
    writeFileSync(sentinel, "preserve this private byte sequence\n");
    const sentinelBefore = readFileSync(sentinel);
    const candidate = wordholdArtifact(root, artifact);

    expect(() => installOrUpdate({
      sourceRoot: candidate,
      installRoot,
      ...(failure === "receipt"
        ? { failAfterReceipt: true }
        : { failAfterWrapper: failure }),
    })).toThrow("simulated update failure");
    expect(readlinkSync(join(installRoot, "current"))).toBe(
      join("releases", installed.activeRelease),
    );
    for (const command of ["papertrail", "pt"]) {
      expect(Bun.spawnSync([join(installRoot, "bin", command)]).exitCode).toBe(0);
    }

    expect(() => installOrUpdate({ sourceRoot: candidate, installRoot })).not.toThrow();
    for (const command of ["wordhold", "papertrail", "pt"]) {
      expect(Bun.spawnSync([join(installRoot, "bin", command)]).exitCode).toBe(0);
    }
    expect(readFileSync(join(dataRoot, "papertrail.config.json"))).toEqual(configBefore);
    expect(readFileSync(sentinel)).toEqual(sentinelBefore);
  }
}, 15_000);

test("an active Wordhold release requires its preferred wrapper", () => {
  const { root, artifact } = fixture();
  const installRoot = join(root, "app");
  const candidate = wordholdArtifact(root, artifact);
  installOrUpdate({
    sourceRoot: candidate,
    installRoot,
    dataRoot: join(root, "data"),
  });
  rmSync(join(installRoot, "bin", "wordhold"));

  expect(() => installOrUpdate({ sourceRoot: candidate, installRoot }))
    .toThrow("managed wrapper inventory changed");
});

test("first install accepts a pre-distribution config with no managed iPhone state", () => {
  const { root, artifact } = fixture();
  const installRoot = join(root, "app");
  const dataRoot = join(root, "legacy-data");
  initializeDataRoot(dataRoot);
  const configPath = join(dataRoot, "papertrail.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  delete config.capabilities;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  expect(installOrUpdate({ sourceRoot: artifact, installRoot, dataRoot }))
    .toMatchObject({ changed: true, shortcutOffer: "unchanged" });
});

test("an existing receipt refuses a conflicting private-data root", () => {
  const { root, artifact } = fixture();
  const installRoot = join(root, "app");
  const originalData = join(root, "original-data");
  const conflictingData = join(root, "different-data");
  installOrUpdate({ sourceRoot: artifact, installRoot, dataRoot: originalData });

  expect(() =>
    installOrUpdate({
      sourceRoot: artifact,
      installRoot,
      dataRoot: conflictingData,
    })
  ).toThrow("refusing to repoint an existing Wordhold installation");
  expect(existsSync(conflictingData)).toBe(false);
});

test("a corrupted existing release is rejected before pointer or receipt mutation", () => {
  const { root, artifact } = fixture();
  const installRoot = join(root, "app");
  const dataRoot = join(root, "data");
  const first = installOrUpdate({ sourceRoot: artifact, installRoot, dataRoot });
  const currentBefore = readlinkSync(join(installRoot, "current"));
  const receiptBefore = readFileSync(join(installRoot, "install.json"), "utf8");
  writeFileSync(
    join(installRoot, "releases", first.activeRelease, "README.md"),
    "tampered release\n",
  );

  expect(() => installOrUpdate({ sourceRoot: artifact, installRoot }))
    .toThrow("artifact hash mismatch");
  expect(readlinkSync(join(installRoot, "current"))).toBe(currentBefore);
  expect(readFileSync(join(installRoot, "install.json"), "utf8")).toBe(receiptBefore);
});

test("uninstall refuses unowned files beneath installer-managed directories", () => {
  for (const relative of ["operator-note.txt", "bin/operator-note.txt", "releases/operator-note.txt"]) {
    const { root, artifact } = fixture();
    const installRoot = join(root, `app-${relative.replaceAll("/", "-")}`);
    const dataRoot = join(root, `data-${relative.replaceAll("/", "-")}`);
    installOrUpdate({ sourceRoot: artifact, installRoot, dataRoot });
    const sentinel = join(installRoot, relative);
    mkdirSync(sentinel.slice(0, sentinel.lastIndexOf("/")), { recursive: true });
    writeFileSync(sentinel, "operator-owned\n");

    expect(() => uninstallProgram(installRoot)).toThrow(/refusing uninstall/);
    expect(readFileSync(sentinel, "utf8")).toBe("operator-owned\n");
    expect(existsSync(join(installRoot, "install.json"))).toBe(true);
    expect(existsSync(dataRoot)).toBe(true);
  }
});

test("a failed first stage is retryable without a stranded program root", () => {
  const { root, artifact } = fixture();
  const installRoot = join(root, "app");
  const dataRoot = join(root, "data");
  expect(() =>
    installOrUpdate({
      sourceRoot: artifact,
      installRoot,
      dataRoot,
      failAfterStage: true,
    })
  ).toThrow("simulated update failure");
  expect(existsSync(installRoot)).toBe(false);
  expect(existsSync(join(dataRoot, "papertrail.config.json"))).toBe(true);
  const retried = installOrUpdate({ sourceRoot: artifact, installRoot, dataRoot });
  expect(retried.dataRoot).toBe(realpathSync(dataRoot));
});

test("first setup rejects nested data-root symlinks before writing through them", () => {
  for (const member of ["agent", ".git"]) {
    const { root, artifact } = fixture();
    const installRoot = join(root, `app-${member.replace(".", "git")}`);
    const dataRoot = join(root, `data-${member.replace(".", "git")}`);
    const external = join(root, `external-${member.replace(".", "git")}`);
    mkdirSync(dataRoot);
    mkdirSync(external);
    writeFileSync(join(dataRoot, "papertrail.config.json"), "{}\n");
    if (member !== ".git") mkdirSync(join(dataRoot, ".git"));
    symlinkSync(external, join(dataRoot, member));

    expect(() => installOrUpdate({ sourceRoot: artifact, installRoot, dataRoot }))
      .toThrow(/unsafe existing Wordhold/);
    expect(readdirSync(external)).toEqual([]);
    expect(existsSync(installRoot)).toBe(false);
  }
});

test("an interrupted v0.1 wrapper migration is always retryable", () => {
  for (const failure of [1, 2, 3, "receipt"] as const) {
    const { root, artifact } = fixture();
    const installRoot = join(root, `app-${failure}`);
    const dataRoot = join(root, `data-${failure}`);
    const installed = installOrUpdate({ sourceRoot: artifact, installRoot, dataRoot });
    const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    for (const binary of ["pt", "papertrail-mcp"]) {
      writeFileSync(
        join(installRoot, "bin", binary),
        `#!/bin/sh\nPAPERTRAIL_ROOT=${shellQuote(realpathSync(dataRoot))} PAPERTRAIL_APP_ROOT=${shellQuote(join(installRoot, "current"))} exec ${shellQuote(join(installRoot, "current", "bin", binary))} "$@"\n`,
        { mode: 0o700 },
      );
    }
    rmSync(join(installRoot, "bin", "papertrail"));
    writeFileSync(
      join(installRoot, "install.json"),
      JSON.stringify({
        format: 1,
        product: "papertrail",
        dataRoot: realpathSync(dataRoot),
        activeRelease: installed.activeRelease,
      }) + "\n",
    );

    expect(() => installOrUpdate({
      sourceRoot: artifact,
      installRoot,
      ...(failure === "receipt"
        ? { failAfterReceipt: true }
        : { failAfterWrapper: failure }),
    })).toThrow("simulated update failure");
    expect(readlinkSync(join(installRoot, "current"))).toBe(
      join("releases", installed.activeRelease),
    );
    expect(() => installOrUpdate({ sourceRoot: artifact, installRoot })).not.toThrow();
    expect(JSON.parse(readFileSync(join(installRoot, "install.json"), "utf8")))
      .toMatchObject({ format: 2, dataRoot: realpathSync(dataRoot) });
  }
});

test("update refuses changed wrappers and managed-directory symlinks before mutation", () => {
  for (const member of ["bin", "releases"]) {
    const { root, artifact } = fixture();
    const installRoot = join(root, `app-${member}`);
    const dataRoot = join(root, `data-${member}`);
    installOrUpdate({ sourceRoot: artifact, installRoot, dataRoot });
    const managed = join(installRoot, member);
    const external = join(root, `external-${member}`);
    renameSync(managed, external);
    symlinkSync(external, managed);
    const sentinel = join(external, "sentinel.txt");
    writeFileSync(sentinel, "outside\n");
    expect(() => installOrUpdate({ sourceRoot: artifact, installRoot }))
      .toThrow(/unsafe|inventory|pointer/);
    expect(readFileSync(sentinel, "utf8")).toBe("outside\n");
  }
});

test("distribution source cannot overlap program or private data roots", () => {
  for (const rootsForAttempt of [
    (artifact: string, root: string) => ({
      installRoot: join(artifact, "app"),
      dataRoot: join(root, "data-one"),
    }),
    (artifact: string, root: string) => ({
      installRoot: join(root, "app-two"),
      dataRoot: join(artifact, "data"),
    }),
  ]) {
    const { root, artifact } = fixture();
    const options = rootsForAttempt(artifact, root);
    expect(() => installOrUpdate({ sourceRoot: artifact, ...options }))
      .toThrow("distribution source must be separate");
    expect(existsSync(options.installRoot)).toBe(false);
    expect(existsSync(options.dataRoot)).toBe(false);
  }
});

test("runtime commands reject a receipt redirected to broad or unrelated data", () => {
  const { root, artifact } = fixture();
  const installRoot = join(root, "app");
  const dataRoot = join(root, "data");
  installOrUpdate({ sourceRoot: artifact, installRoot, dataRoot });
  const receiptPath = join(installRoot, "install.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.dataRoot = homedir();
  writeFileSync(receiptPath, JSON.stringify(receipt));
  expect(() => installedDataRoot(installRoot)).toThrow(/broad|data root/);
});
