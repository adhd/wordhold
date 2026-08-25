import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

// These tests cross the real subprocess/filesystem boundary through
// deterministic Codex and Hermes CLI contract doubles. Under the full parallel
// suite the subprocesses can exceed Bun's 5-second unit-test default.
setDefaultTimeout(20_000);
import { join } from "node:path";
import { initializeDataRoot } from "../core/installation.ts";
import {
  installAgentIntegrations,
  removeAgentIntegrations,
} from "../scripts/install-agent-integrations.ts";
import { withFakeAgentClients } from "./helpers/fake-agent-clients.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function output(result: ReturnType<typeof Bun.spawnSync>): string {
  return new TextDecoder().decode(result.stdout);
}

function expectSuccess(result: ReturnType<typeof Bun.spawnSync>): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${output(result)}${new TextDecoder().decode(result.stderr)}`.trim(),
    );
  }
}

test("installer configures Codex and Hermes CLI contracts in isolated homes", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-agent-install-"));
  roots.push(root);
  const codexHome = join(root, "codex-home");
  const hermesHome = join(root, "hermes-home");
  const dataRoot = join(root, "corpus");
  initializeDataRoot(dataRoot);
  const env = withFakeAgentClients(root, {
    ...process.env,
    CODEX_HOME: codexHome,
    HERMES_HOME: hermesHome,
  });
  const script = join(
    import.meta.dir,
    "..",
    "scripts",
    "install-agent-integrations.ts",
  );

  for (const client of ["codex", "hermes", "codex", "hermes"]) {
    expectSuccess(Bun.spawnSync(
      [process.execPath, script, "--data-root", dataRoot, "--client", client],
      { env },
    ));
  }

  const codex = Bun.spawnSync(["codex", "mcp", "get", "papertrail", "--json"], {
    env,
  });
  expect(codex.exitCode).toBe(0);
  expect(JSON.parse(output(codex))).toMatchObject({
    name: "papertrail",
    transport: {
      type: "stdio",
      command: process.execPath,
      env: { PAPERTRAIL_ROOT: dataRoot },
    },
  });

  const hermes = Bun.spawnSync(["hermes", "mcp", "test", "papertrail"], {
    env,
  });
  expect(hermes.exitCode).toBe(0);
  expect(output(hermes)).toContain("search_items");
  const skill = readFileSync(
    join(hermesHome, "skills", "papertrail", "SKILL.md"),
    "utf8",
  );
  expect(skill).toContain("search_items");
  expect(skill).not.toContain("/Users/example");
  expect(skill).not.toContain("PAPERTRAIL_SECRET");
}, 20_000);

test("Codex-only installation does not create Hermes state", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-agent-codex-only-"));
  roots.push(root);
  const codexHome = join(root, "codex-home");
  const hermesHome = join(root, "hermes-home");
  const dataRoot = initializeDataRoot(join(root, "corpus")).dataRoot;
  const script = join(
    import.meta.dir,
    "..",
    "scripts",
    "install-agent-integrations.ts",
  );
  const env = withFakeAgentClients(root, {
    ...process.env,
    CODEX_HOME: codexHome,
    HERMES_HOME: hermesHome,
  }, ["codex"]);

  const result = Bun.spawnSync(
    [process.execPath, script, "--data-root", dataRoot, "--client", "codex"],
    { env },
  );
  expectSuccess(result);
  expect(
    Bun.spawnSync(["codex", "mcp", "get", "papertrail", "--json"], { env })
      .exitCode,
  ).toBe(0);
  expect(existsSync(hermesHome)).toBe(false);
});

test("Hermes-only installation does not create Codex state", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-agent-hermes-only-"));
  roots.push(root);
  const codexHome = join(root, "codex-home");
  const hermesHome = join(root, "hermes-home");
  const dataRoot = initializeDataRoot(join(root, "corpus")).dataRoot;
  const script = join(
    import.meta.dir,
    "..",
    "scripts",
    "install-agent-integrations.ts",
  );
  const env = withFakeAgentClients(root, {
    ...process.env,
    CODEX_HOME: codexHome,
    HERMES_HOME: hermesHome,
  }, ["hermes"]);
  const result = Bun.spawnSync(
    [process.execPath, script, "--data-root", dataRoot, "--client", "hermes"],
    { env },
  );
  expectSuccess(result);
  expect(existsSync(codexHome)).toBe(false);
  expect(readFileSync(join(hermesHome, "skills", "papertrail", "SKILL.md"), "utf8"))
    .toContain("search_items");
});

test("installation refuses a non-Wordhold data root before touching clients", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-agent-wrong-root-"));
  roots.push(root);
  const codexHome = join(root, "codex-home");
  const hermesHome = join(root, "hermes-home");
  const script = join(
    import.meta.dir,
    "..",
    "scripts",
    "install-agent-integrations.ts",
  );
  const result = Bun.spawnSync(
    [process.execPath, script, "--data-root", root, "--client", "codex"],
    { env: { ...process.env, CODEX_HOME: codexHome, HERMES_HOME: hermesHome } },
  );

  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain(
    "initialized Wordhold data root",
  );
  expect(existsSync(codexHome)).toBe(false);
  expect(existsSync(hermesHome)).toBe(false);
});

test("missing requested client fails preflight without partially installing another", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-agent-missing-client-"));
  roots.push(root);
  const codexHome = join(root, "codex-home");
  const hermesHome = join(root, "hermes-home");
  const dataRoot = initializeDataRoot(join(root, "corpus")).dataRoot;
  const script = join(
    import.meta.dir,
    "..",
    "scripts",
    "install-agent-integrations.ts",
  );
  const env = withFakeAgentClients(root, {
    PATH: "/usr/bin:/bin",
    CODEX_HOME: codexHome,
    HERMES_HOME: hermesHome,
  }, ["codex"]);

  const result = Bun.spawnSync(
    [process.execPath, script, "--data-root", dataRoot, "--client", "hermes"],
    { env },
  );
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain(
    "requested Hermes client is not installed",
  );
  expect(
    Bun.spawnSync(["codex", "mcp", "get", "papertrail", "--json"], {
      env,
    }).exitCode,
  ).not.toBe(0);
  expect(existsSync(hermesHome)).toBe(false);
});

test("multi-client installation is rejected before touching either client", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-agent-rollback-"));
  roots.push(root);
  const codexHome = join(root, "codex-home");
  const hermesHome = join(root, "hermes-home");
  const dataRoot = initializeDataRoot(join(root, "corpus")).dataRoot;
  const script = join(
    import.meta.dir,
    "..",
    "scripts",
    "install-agent-integrations.ts",
  );
  const env = withFakeAgentClients(root, {
    PATH: "/usr/bin:/bin",
    CODEX_HOME: codexHome,
    HERMES_HOME: hermesHome,
  });

  const result = Bun.spawnSync(
    [process.execPath, script, "--data-root", dataRoot, "--client", "all"],
    { env },
  );
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("codex or hermes");
  expect(
    Bun.spawnSync(["codex", "mcp", "get", "papertrail", "--json"], {
      env,
    }).exitCode,
  ).not.toBe(0);
  expect(output(Bun.spawnSync(["hermes", "mcp", "list"], { env }))).toBe("");
});

test("packaged reinstall refreshes an unchanged managed Hermes skill", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-agent-refresh-"));
  roots.push(root);
  const installRoot = join(root, "install");
  const appV1 = join(root, "app-v1");
  const appV2 = join(root, "app-v2");
  const hermesHome = join(root, "hermes-home");
  const dataRoot = initializeDataRoot(join(root, "corpus")).dataRoot;
  mkdirSync(join(installRoot, "bin"), { recursive: true });
  writeFileSync(
    join(installRoot, "install.json"),
    JSON.stringify({ format: 1, product: "papertrail", dataRoot, activeRelease: "v1" }),
  );
  const mcp = join(installRoot, "bin", "papertrail-mcp");
  writeFileSync(mcp, "#!/bin/sh\nexit 1\n");
  chmodSync(mcp, 0o700);
  for (const [appRoot, text] of [[appV1, "managed v1\n"], [appV2, "managed v2\n"]]) {
    const skill = join(appRoot, "integrations", "hermes", "papertrail", "SKILL.md");
    mkdirSync(join(appRoot, "mcp"), { recursive: true });
    mkdirSync(join(skill, ".."), { recursive: true });
    writeFileSync(skill, text);
  }
  const env = withFakeAgentClients(
    root,
    { ...process.env, HERMES_HOME: hermesHome },
    ["hermes"],
  );

  installAgentIntegrations({
    appRoot: appV1,
    installRoot,
    dataRoot,
    clients: ["hermes"],
    env,
  });
  installAgentIntegrations({
    appRoot: appV2,
    installRoot,
    dataRoot,
    clients: ["hermes"],
    env,
  });

  const receipt = JSON.parse(
    readFileSync(join(installRoot, "agent-integrations.json"), "utf8"),
  );
  expect(receipt.installedClients).toEqual(["hermes"]);
  expect(receipt.managed.hermes).toMatchObject({
    home: hermesHome,
    markerPath: join(hermesHome, "papertrail-mcp-install.json"),
    skillPath: join(hermesHome, "skills", "papertrail", "SKILL.md"),
    expected: { env: { PAPERTRAIL_ROOT: dataRoot } },
    skillSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    entryFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(
    readFileSync(join(hermesHome, "skills", "papertrail", "SKILL.md"), "utf8"),
  ).toBe("managed v2\n");
}, 20_000);

test("packaged install refuses to adopt an unmanaged matching Codex entry", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-agent-unmanaged-codex-"));
  roots.push(root);
  const installRoot = join(root, "install");
  const appRoot = join(root, "app");
  const codexHome = join(root, "codex-home");
  const dataRoot = initializeDataRoot(join(root, "corpus")).dataRoot;
  mkdirSync(join(installRoot, "bin"), { recursive: true });
  mkdirSync(join(appRoot, "mcp"), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(installRoot, "install.json"),
    JSON.stringify({ format: 1, product: "papertrail", dataRoot, activeRelease: "v1" }),
  );
  const mcp = join(installRoot, "bin", "papertrail-mcp");
  writeFileSync(mcp, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const env = withFakeAgentClients(
    root,
    { ...process.env, CODEX_HOME: codexHome },
    ["codex"],
  );
  expectSuccess(Bun.spawnSync([
    "codex", "mcp", "add", "papertrail", "--env", `PAPERTRAIL_ROOT=${dataRoot}`,
    "--", mcp,
  ], { env }));

  expect(() => installAgentIntegrations({
    appRoot,
    installRoot,
    dataRoot,
    clients: ["codex"],
    env,
  })).toThrow(/unmanaged papertrail MCP entry/i);
  expect(
    Bun.spawnSync(["codex", "mcp", "get", "papertrail", "--json"], { env }).exitCode,
  ).toBe(0);
  expect(existsSync(join(installRoot, "agent-integrations.json"))).toBe(false);
}, 20_000);

test("packaged reinstall refuses and preserves a customized Hermes skill", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-agent-custom-skill-"));
  roots.push(root);
  const installRoot = join(root, "install");
  const appV1 = join(root, "app-v1");
  const appV2 = join(root, "app-v2");
  const hermesHome = join(root, "hermes-home");
  const dataRoot = initializeDataRoot(join(root, "corpus")).dataRoot;
  mkdirSync(join(installRoot, "bin"), { recursive: true });
  writeFileSync(
    join(installRoot, "install.json"),
    JSON.stringify({ format: 1, product: "papertrail", dataRoot, activeRelease: "v1" }),
  );
  const mcp = join(installRoot, "bin", "papertrail-mcp");
  writeFileSync(mcp, "#!/bin/sh\nexit 1\n");
  chmodSync(mcp, 0o700);
  for (const [appRoot, text] of [[appV1, "managed v1\n"], [appV2, "managed v2\n"]]) {
    const skillDir = join(appRoot, "integrations", "hermes", "papertrail");
    mkdirSync(join(appRoot, "mcp"), { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), text);
  }
  const env = withFakeAgentClients(
    root,
    { ...process.env, HERMES_HOME: hermesHome },
    ["hermes"],
  );
  installAgentIntegrations({
    appRoot: appV1,
    installRoot,
    dataRoot,
    clients: ["hermes"],
    env,
  });
  const installedSkill = join(hermesHome, "skills", "papertrail", "SKILL.md");
  writeFileSync(installedSkill, "operator customization\n");

  expect(() =>
    installAgentIntegrations({
      appRoot: appV2,
      installRoot,
      dataRoot,
      clients: ["hermes"],
      env,
    })
  ).toThrow("preserve/review");
  expect(readFileSync(installedSkill, "utf8")).toBe("operator customization\n");
}, 20_000);

test("managed removal is selective and preserves program and private data", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-agent-remove-"));
  roots.push(root);
  const installRoot = join(root, "install");
  const appRoot = join(root, "app");
  const codexHome = join(root, "codex-home");
  const hermesHome = join(root, "hermes-home");
  const dataRoot = initializeDataRoot(join(root, "corpus")).dataRoot;
  mkdirSync(join(installRoot, "bin"), { recursive: true });
  writeFileSync(
    join(installRoot, "install.json"),
    JSON.stringify({ format: 1, product: "papertrail", dataRoot, activeRelease: "v1" }),
  );
  const mcp = join(installRoot, "bin", "papertrail-mcp");
  writeFileSync(mcp, "#!/bin/sh\nexit 1\n");
  chmodSync(mcp, 0o700);
  const skillDir = join(appRoot, "integrations", "hermes", "papertrail");
  mkdirSync(join(appRoot, "mcp"), { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "managed skill\n");
  const env = withFakeAgentClients(root, {
    ...process.env,
    CODEX_HOME: codexHome,
    HERMES_HOME: hermesHome,
  });
  installAgentIntegrations({ appRoot, installRoot, dataRoot, clients: ["codex"], env });
  installAgentIntegrations({ appRoot, installRoot, dataRoot, clients: ["hermes"], env });

  expect(removeAgentIntegrations({ installRoot, clients: ["codex"], env }))
    .toEqual(["codex"]);
  expect(
    Bun.spawnSync(["codex", "mcp", "get", "papertrail", "--json"], { env })
      .exitCode,
  ).not.toBe(0);
  expect(output(Bun.spawnSync(["hermes", "mcp", "list"], { env })))
    .toMatch(/\bpapertrail\b/i);
  expect(existsSync(join(installRoot, "agent-integrations.json"))).toBe(true);

  expect(removeAgentIntegrations({ installRoot, clients: ["hermes"], env }))
    .toEqual(["hermes"]);
  expect(existsSync(join(hermesHome, "skills", "papertrail", "SKILL.md")))
    .toBe(false);
  expect(existsSync(join(installRoot, "agent-integrations.json"))).toBe(false);
  expect(existsSync(join(installRoot, "install.json"))).toBe(true);
  expect(existsSync(join(dataRoot, "papertrail.config.json"))).toBe(true);
}, 20_000);

test("managed removal refuses and preserves a customized Hermes skill", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-agent-remove-custom-"));
  roots.push(root);
  const installRoot = join(root, "install");
  const appRoot = join(root, "app");
  const hermesHome = join(root, "hermes-home");
  const dataRoot = initializeDataRoot(join(root, "corpus")).dataRoot;
  mkdirSync(join(installRoot, "bin"), { recursive: true });
  writeFileSync(
    join(installRoot, "install.json"),
    JSON.stringify({ format: 1, product: "papertrail", dataRoot, activeRelease: "v1" }),
  );
  const mcp = join(installRoot, "bin", "papertrail-mcp");
  writeFileSync(mcp, "#!/bin/sh\nexit 1\n");
  chmodSync(mcp, 0o700);
  const skillDir = join(appRoot, "integrations", "hermes", "papertrail");
  mkdirSync(join(appRoot, "mcp"), { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "managed skill\n");
  const env = withFakeAgentClients(
    root,
    { ...process.env, HERMES_HOME: hermesHome },
    ["hermes"],
  );
  installAgentIntegrations({
    appRoot,
    installRoot,
    dataRoot,
    clients: ["hermes"],
    env,
  });
  const skillPath = join(hermesHome, "skills", "papertrail", "SKILL.md");
  writeFileSync(skillPath, "operator customization\n");

  expect(() =>
    removeAgentIntegrations({ installRoot, clients: ["hermes"], env })
  ).toThrow("preserving it");
  expect(readFileSync(skillPath, "utf8")).toBe("operator customization\n");
  expect(output(Bun.spawnSync(["hermes", "mcp", "list"], { env })))
    .toMatch(/\bpapertrail\b/i);
  expect(existsSync(join(installRoot, "agent-integrations.json"))).toBe(true);
}, 20_000);

test("Hermes removal compensation restores the entry after later cleanup failure", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-agent-remove-rollback-"));
  roots.push(root);
  const installRoot = join(root, "install");
  const appRoot = join(root, "app");
  const hermesHome = join(root, "hermes-home");
  const dataRoot = initializeDataRoot(join(root, "corpus")).dataRoot;
  mkdirSync(join(installRoot, "bin"), { recursive: true });
  writeFileSync(
    join(installRoot, "install.json"),
    JSON.stringify({ format: 1, product: "papertrail", dataRoot, activeRelease: "v1" }),
  );
  writeFileSync(join(installRoot, "bin", "papertrail-mcp"), "#!/bin/sh\n", { mode: 0o700 });
  const skillDir = join(appRoot, "integrations", "hermes", "papertrail");
  mkdirSync(join(appRoot, "mcp"), { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "managed skill\n");
  const env = withFakeAgentClients(
    root,
    { ...process.env, HERMES_HOME: hermesHome },
    ["hermes"],
  );
  installAgentIntegrations({ appRoot, installRoot, dataRoot, clients: ["hermes"], env });

  expect(() => removeAgentIntegrations({
    installRoot,
    clients: ["hermes"],
    env: { ...env, PAPERTRAIL_TEST_FAIL_AFTER_HERMES_REMOVE: "1" },
  })).toThrow(/simulated failure/);
  expect(output(Bun.spawnSync(["hermes", "mcp", "list"], { env }))).toMatch(/papertrail/i);
  expect(existsSync(join(installRoot, "agent-integrations.json"))).toBe(true);
  expect(existsSync(join(hermesHome, "skills", "papertrail", "SKILL.md"))).toBe(true);
}, 20_000);
