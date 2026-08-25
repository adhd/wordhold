// Configure and revoke the real local Codex/Hermes MCP clients. A packaged
// receipt records only the pointers Wordhold owns; corpus data and credentials
// never enter client configuration.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveRepoRoot } from "../core/config.ts";

export type AgentClient = "codex" | "hermes";

interface ExpectedMcp {
  command: string;
  args: string[];
  env: Record<string, string> & { PAPERTRAIL_ROOT: string };
}

interface ManagedCodex {
  home: string;
  expected: ExpectedMcp;
}

interface ManagedHermes {
  home: string;
  expected: ExpectedMcp;
  markerPath: string;
  skillPath: string;
  skillSha256: string;
  entryFingerprint: string;
}

export interface AgentIntegrationReceipt {
  format: 2;
  product: "papertrail";
  dataRoot: string;
  installedClients: AgentClient[];
  managed: {
    codex?: ManagedCodex;
    hermes?: ManagedHermes;
  };
}

export interface InstallAgentIntegrationsOptions {
  appRoot?: string;
  installRoot?: string;
  dataRoot: string;
  clients?: AgentClient[];
  env?: Record<string, string | undefined>;
}

export interface RemoveAgentIntegrationsOptions {
  installRoot: string;
  clients?: AgentClient[];
  env?: Record<string, string | undefined>;
}

export function managedAgentClients(installRoot: string): AgentClient[] {
  return [...(readReceipt(resolve(installRoot))?.installedClients ?? [])];
}

function hash(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

function selectedClients(clients: AgentClient[] | undefined): AgentClient[] {
  const selected = clients ?? [];
  if (!selected.length || selected.some((client) => client !== "codex" && client !== "hermes")) {
    throw new Error("select exactly one client: codex or hermes");
  }
  const unique = [...new Set(selected)];
  if (unique.length !== 1) throw new Error("install or remove one client per command");
  return unique;
}

function run(
  args: string[],
  env: Record<string, string | undefined>,
  stdin?: string,
): { stdout: string; stderr: string } {
  const result = Bun.spawnSync(args, {
    env,
    ...(stdin ? { stdin: new TextEncoder().encode(stdin) } : {}),
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`${args[0]} failed: ${(stderr || stdout).trim()}`);
  }
  return { stdout, stderr };
}

function ensureDataRoot(rawRoot: string): string {
  const dataRoot = isAbsolute(rawRoot) ? rawRoot : resolve(rawRoot);
  if (!existsSync(dataRoot)) {
    throw new Error(`Wordhold data root does not exist: ${dataRoot}`);
  }
  if (
    !existsSync(join(dataRoot, "papertrail.config.json")) ||
    !existsSync(join(dataRoot, ".git"))
  ) {
    throw new Error(`not an initialized Wordhold data root: ${dataRoot}`);
  }
  return dataRoot;
}

function requireClients(
  clients: AgentClient[],
  env: Record<string, string | undefined>,
): void {
  for (const client of clients) {
    if (!Bun.which(client, { PATH: env.PATH })) {
      const label = client === "codex" ? "Codex" : "Hermes";
      throw new Error(`requested ${label} client is not installed`);
    }
  }
}

function sameExpected(a: ExpectedMcp, b: ExpectedMcp): boolean {
  return a.command === b.command &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    JSON.stringify(a.env) === JSON.stringify(b.env);
}

function codexEntry(
  env: Record<string, string | undefined>,
): ExpectedMcp | null {
  const result = Bun.spawnSync(["codex", "mcp", "get", "papertrail", "--json"], { env });
  if (result.exitCode !== 0) return null;
  const current = JSON.parse(new TextDecoder().decode(result.stdout)) as {
    transport?: {
      type?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    };
  };
  if (current.transport?.type !== "stdio" || !current.transport.command) return null;
  return {
    command: current.transport.command,
    args: current.transport.args ?? [],
    env: current.transport.env as ExpectedMcp["env"],
  };
}

function addCodex(expected: ExpectedMcp, env: Record<string, string | undefined>): void {
  run([
    "codex",
    "mcp",
    "add",
    "papertrail",
    "--env",
    `PAPERTRAIL_ROOT=${expected.env.PAPERTRAIL_ROOT}`,
    "--",
    expected.command,
    ...expected.args,
  ], env);
}

function addHermes(expected: ExpectedMcp, env: Record<string, string | undefined>): void {
  run([
    "hermes",
    "mcp",
    "add",
    "papertrail",
    "--command",
    expected.command,
    "--env",
    `PAPERTRAIL_ROOT=${expected.env.PAPERTRAIL_ROOT}`,
    ...(expected.args.length ? ["--args", ...expected.args] : []),
  ], env, "y\n");
}

function hermesEntryFingerprint(hermesHome: string): string {
  const configPath = join(hermesHome, "config.yaml");
  if (!existsSync(configPath)) throw new Error("Hermes papertrail MCP entry is missing");
  const lines = readFileSync(configPath, "utf8").split("\n");
  const servers = lines.findIndex((line) => line === "mcp_servers:");
  const start = lines.findIndex(
    (line, index) => index > servers && /^  papertrail:\s*$/.test(line),
  );
  if (servers < 0 || start < 0) throw new Error("Hermes papertrail MCP entry is missing");
  const block: string[] = [];
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    if (index > start && (/^\S/.test(line) || /^  [^\s]/.test(line))) break;
    // Hermes may toggle operational enablement after a successful test; the
    // owned command/args/environment remain the authority being verified.
    if (!/^\s+enabled:\s*/.test(line)) block.push(line);
  }
  return hash(block.join("\n"));
}

function receiptPath(installRoot: string): string {
  return join(installRoot, "agent-integrations.json");
}

function readReceipt(installRoot: string): AgentIntegrationReceipt | null {
  const path = receiptPath(installRoot);
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error("invalid Wordhold agent integration receipt");
  }
  const receipt = JSON.parse(readFileSync(path, "utf8")) as AgentIntegrationReceipt;
  if (
    receipt.format !== 2 ||
    receipt.product !== "papertrail" ||
    !receipt.managed ||
    !Array.isArray(receipt.installedClients)
  ) {
    throw new Error("invalid Wordhold agent integration receipt");
  }
  const installed = [...receipt.installedClients].sort();
  const managed = (["codex", "hermes"] as AgentClient[])
    .filter((client) => receipt.managed[client] !== undefined)
    .sort();
  if (
    JSON.stringify(installed) !== JSON.stringify(managed) ||
    installed.some((client) => client !== "codex" && client !== "hermes")
  ) {
    throw new Error("invalid Wordhold agent integration receipt");
  }
  const expectedCommand = join(installRoot, "bin", "papertrail-mcp");
  for (const client of managed) {
    const record = receipt.managed[client]!;
    if (
      !isAbsolute(record.home) ||
      !existsSync(record.expected.command) ||
      realpathSync(record.expected.command) !== realpathSync(expectedCommand) ||
      record.expected.args.length !== 0 ||
      !existsSync(record.expected.env.PAPERTRAIL_ROOT) ||
      realpathSync(record.expected.env.PAPERTRAIL_ROOT) !== realpathSync(receipt.dataRoot)
    ) {
      throw new Error("invalid Wordhold agent integration receipt");
    }
    if (client === "hermes") {
      const hermes = receipt.managed.hermes!;
      if (
        hermes.markerPath !== join(hermes.home, "papertrail-mcp-install.json") ||
        hermes.skillPath !== join(hermes.home, "skills", "papertrail", "SKILL.md")
      ) {
        throw new Error("invalid Wordhold agent integration receipt");
      }
    }
  }
  return receipt;
}

function writeReceipt(installRoot: string, receipt: AgentIntegrationReceipt): void {
  writeFileSync(receiptPath(installRoot), JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function installAgentIntegrations(
  options: InstallAgentIntegrationsOptions,
): AgentIntegrationReceipt | null {
  const env = options.env ?? process.env;
  const clients = selectedClients(options.clients);
  const appRoot = resolve(options.appRoot ?? dirname(import.meta.dir));
  const installRoot = resolve(options.installRoot ?? resolve(appRoot, "..", ".."));
  const dataRoot = ensureDataRoot(options.dataRoot);
  requireClients(clients, env);

  const lifecycleMcp = join(installRoot, "bin", "papertrail-mcp");
  const compiledServer = join(appRoot, "bin", "papertrail-mcp");
  const serverPath = join(appRoot, "mcp", "server.ts");
  const packaged = existsSync(join(installRoot, "install.json"));
  const serverCommand = packaged && existsSync(lifecycleMcp)
    ? lifecycleMcp
    : existsSync(compiledServer)
      ? compiledServer
      : process.execPath;
  const expected: ExpectedMcp = {
    command: serverCommand,
    args: serverCommand === process.execPath ? [serverPath] : [],
    env: { PAPERTRAIL_ROOT: dataRoot },
  };
  const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
  const hermesHome = env.HERMES_HOME || join(homedir(), ".hermes");
  const markerPath = join(hermesHome, "papertrail-mcp-install.json");
  const skillSource = join(appRoot, "integrations", "hermes", "papertrail", "SKILL.md");
  const skillPath = join(hermesHome, "skills", "papertrail", "SKILL.md");
  const prior = packaged ? readReceipt(installRoot) : null;
  if (prior && prior.dataRoot !== dataRoot) {
    throw new Error(
      `managed agent integrations belong to a different Wordhold data root: ${prior.dataRoot}`,
    );
  }

  // Complete preflight before creating a home, client entry, marker, or skill.
  if (clients.includes("codex")) {
    const current = codexEntry(env);
    if (current && packaged && !prior?.managed.codex) {
      throw new Error(
        "Codex already has an unmanaged papertrail MCP entry; review/remove it before installation",
      );
    }
    if (current && !sameExpected(current, expected)) {
      throw new Error(
        "Codex already has a different papertrail MCP entry; review/remove it before installation",
      );
    }
  }
  let refreshSkill = false;
  if (clients.includes("hermes")) {
    if (!existsSync(skillSource)) {
      throw new Error(`Wordhold Hermes skill missing: ${skillSource}`);
    }
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as ExpectedMcp;
      if (!sameExpected(marker, expected)) {
        throw new Error(
          "Hermes has a different managed Wordhold MCP entry; review/remove it before installation",
        );
      }
      if (prior?.managed.hermes) {
        if (hermesEntryFingerprint(hermesHome) !== prior.managed.hermes.entryFingerprint) {
          throw new Error("Hermes papertrail MCP entry changed after installation");
        }
      }
    } else {
      const listed = run(["hermes", "mcp", "list"], env).stdout;
      if (/\bpapertrail\b/i.test(listed)) {
        throw new Error(
          "Hermes already has an unmanaged papertrail MCP entry; review/remove it before installation",
        );
      }
    }
    if (existsSync(skillPath)) {
      const currentHash = hash(readFileSync(skillPath));
      const sourceHash = hash(readFileSync(skillSource));
      if (currentHash !== sourceHash) {
        if (prior?.managed.hermes?.skillSha256 !== currentHash) {
          throw new Error(
            `Hermes Wordhold skill differs at ${skillPath}; preserve/review it before replacing it`,
          );
        }
        refreshSkill = true;
      }
    }
  }

  if (clients.includes("codex") && env.CODEX_HOME) mkdirSync(codexHome, { recursive: true });
  if (clients.includes("hermes") && env.HERMES_HOME) mkdirSync(hermesHome, { recursive: true });

  let createdCodex = false;
  let createdHermes = false;
  let createdMarker = false;
  let createdSkill = false;
  let previousSkill: Uint8Array | null = null;
  const priorReceiptText = packaged && existsSync(receiptPath(installRoot))
    ? readFileSync(receiptPath(installRoot), "utf8")
    : null;
  try {
    if (clients.includes("codex") && !codexEntry(env)) {
      createdCodex = true;
      addCodex(expected, env);
    }
    if (clients.includes("hermes")) {
      if (!existsSync(markerPath)) {
        createdHermes = true;
        addHermes(expected, env);
        writeFileSync(markerPath, JSON.stringify(expected, null, 2) + "\n", { mode: 0o600 });
        createdMarker = true;
      }
      if (!existsSync(skillPath)) {
        mkdirSync(dirname(skillPath), { recursive: true });
        copyFileSync(skillSource, skillPath);
        createdSkill = true;
      } else if (refreshSkill) {
        previousSkill = readFileSync(skillPath);
        copyFileSync(skillSource, skillPath);
      }
    }

    if (!packaged) return null;
    const managed = { ...(prior?.managed ?? {}) };
    if (clients.includes("codex")) managed.codex = { home: codexHome, expected };
    if (clients.includes("hermes")) {
      managed.hermes = {
        home: hermesHome,
        expected,
        markerPath,
        skillPath,
        skillSha256: hash(readFileSync(skillPath)),
        entryFingerprint: hermesEntryFingerprint(hermesHome),
      };
    }
    const installedClients = (["codex", "hermes"] as AgentClient[])
      .filter((client) => managed[client] !== undefined);
    const receipt: AgentIntegrationReceipt = {
      format: 2,
      product: "papertrail",
      dataRoot,
      installedClients,
      managed,
    };
    writeReceipt(installRoot, receipt);
    return receipt;
  } catch (error) {
    if (createdHermes) {
      Bun.spawnSync(["hermes", "mcp", "remove", "papertrail"], { env });
    }
    if (createdMarker) rmSync(markerPath, { force: true });
    if (createdSkill) rmSync(skillPath, { force: true });
    if (previousSkill) writeFileSync(skillPath, previousSkill);
    if (createdCodex) {
      Bun.spawnSync(["codex", "mcp", "remove", "papertrail"], { env });
    }
    if (packaged) {
      if (priorReceiptText === null) rmSync(receiptPath(installRoot), { force: true });
      else writeFileSync(receiptPath(installRoot), priorReceiptText, { mode: 0o600 });
    }
    throw error;
  }
}

function verifyManagedClient(
  client: AgentClient,
  receipt: AgentIntegrationReceipt,
  env: Record<string, string | undefined>,
): void {
  if (client === "codex") {
    const managed = receipt.managed.codex;
    if (!managed) throw new Error("Codex is not managed by this Wordhold installation");
    const current = codexEntry({ ...env, CODEX_HOME: managed.home });
    if (!current || !sameExpected(current, managed.expected)) {
      throw new Error("Codex papertrail MCP entry changed after installation");
    }
    return;
  }
  const managed = receipt.managed.hermes;
  if (!managed) throw new Error("Hermes is not managed by this Wordhold installation");
  if (
    !existsSync(managed.markerPath) ||
    !sameExpected(
      JSON.parse(readFileSync(managed.markerPath, "utf8")) as ExpectedMcp,
      managed.expected,
    ) ||
    hermesEntryFingerprint(managed.home) !== managed.entryFingerprint
  ) {
    throw new Error("Hermes papertrail MCP entry changed after installation");
  }
  if (
    !existsSync(managed.skillPath) ||
    hash(readFileSync(managed.skillPath)) !== managed.skillSha256
  ) {
    throw new Error("Hermes Wordhold skill changed after installation; preserving it");
  }
}

export function preflightAgentIntegrationRemoval(
  options: RemoveAgentIntegrationsOptions,
): AgentClient[] {
  const installRoot = resolve(options.installRoot);
  const receipt = readReceipt(installRoot);
  if (!receipt) throw new Error("Wordhold agent integration receipt is missing");
  const clients = options.clients
    ? selectedClients(options.clients)
    : [...receipt.installedClients];
  const env = options.env ?? process.env;
  requireClients(clients, env);
  for (const client of clients) verifyManagedClient(client, receipt, env);
  return clients;
}

export function removeAgentIntegrations(
  options: RemoveAgentIntegrationsOptions,
): AgentClient[] {
  const installRoot = resolve(options.installRoot);
  const receipt = readReceipt(installRoot);
  if (!receipt) throw new Error("Wordhold agent integration receipt is missing");
  if (!options.clients && receipt.installedClients.length > 1) {
    const removed: AgentClient[] = [];
    for (const client of [...receipt.installedClients]) {
      removed.push(...removeAgentIntegrations({ ...options, clients: [client] }));
    }
    return removed;
  }
  const clients = selectedClients(options.clients ?? receipt.installedClients);
  const env = options.env ?? process.env;
  preflightAgentIntegrationRemoval({ ...options, clients });

  const original = structuredClone(receipt);
  const next = structuredClone(receipt);
  const originalHermesSkill = original.managed.hermes
    ? readFileSync(original.managed.hermes.skillPath)
    : null;
  const removed: AgentClient[] = [];
  try {
    for (const client of clients) {
      if (client === "codex") {
        const managed = receipt.managed.codex!;
        run(["codex", "mcp", "remove", "papertrail"], {
          ...env,
          CODEX_HOME: managed.home,
        });
        delete next.managed.codex;
      } else {
        const managed = receipt.managed.hermes!;
        run(["hermes", "mcp", "remove", "papertrail"], {
          ...env,
          HERMES_HOME: managed.home,
        });
        // From this point compensation must restore the client entry if any
        // later owned-file cleanup fails.
        removed.push(client);
        if (env.PAPERTRAIL_TEST_FAIL_AFTER_HERMES_REMOVE === "1") {
          throw new Error("simulated failure after Hermes client removal");
        }
        rmSync(managed.markerPath, { force: true });
        rmSync(managed.skillPath, { force: true });
        delete next.managed.hermes;
      }
      if (client === "codex") removed.push(client);
    }
    next.installedClients = receipt.installedClients.filter(
      (client) => !removed.includes(client),
    );
    if (next.installedClients.length) writeReceipt(installRoot, next);
    else rmSync(receiptPath(installRoot), { force: true });
    return removed;
  } catch (error) {
    // Removal is normally preflighted. If a later client command still fails,
    // restore only entries removed by this invocation using the exact receipt.
    for (const client of removed.reverse()) {
      if (client === "codex") {
        const managed = original.managed.codex;
        if (managed) addCodex(managed.expected, { ...env, CODEX_HOME: managed.home });
      } else {
        const managed = original.managed.hermes;
        if (managed) {
          addHermes(managed.expected, { ...env, HERMES_HOME: managed.home });
          writeFileSync(
            managed.markerPath,
            JSON.stringify(managed.expected, null, 2) + "\n",
            { mode: 0o600 },
          );
          mkdirSync(dirname(managed.skillPath), { recursive: true });
          if (originalHermesSkill) writeFileSync(managed.skillPath, originalHermesSkill);
        }
      }
    }
    writeReceipt(installRoot, original);
    throw error;
  }
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function cliClients(raw: string | undefined): AgentClient[] {
  if (!raw) throw new Error("--client codex or --client hermes is required");
  if (raw === "codex" || raw === "hermes") return [raw];
  throw new Error("--client must be codex or hermes");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const appRoot = dirname(import.meta.dir);
  const installRoot = resolve(appRoot, "..", "..");
  const rawClient = argument(args, "--client");
  if (args.includes("--remove")) {
    const removed = removeAgentIntegrations({
      installRoot,
      clients: cliClients(rawClient),
    });
    console.log(JSON.stringify({ status: "removed", clients: removed }));
  } else {
    const clients = cliClients(rawClient);
    const rawDataRoot = argument(args, "--data-root") ?? resolveRepoRoot();
    const dataRoot = isAbsolute(rawDataRoot) ? rawDataRoot : resolve(rawDataRoot);
    installAgentIntegrations({ appRoot, installRoot, dataRoot, clients });
    console.log(
      JSON.stringify({
        status: "installed",
        dataRoot,
        clients,
      }),
    );
  }
}
