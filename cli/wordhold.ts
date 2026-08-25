import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  installOrUpdate,
  installedDataRoot,
  preflightUninstallProgram,
  uninstallProgram,
} from "../scripts/lifecycle.ts";
import {
  installAgentIntegrations,
  managedAgentClients,
  removeAgentIntegrations,
  type AgentClient,
} from "../scripts/install-agent-integrations.ts";
import {
  installLaunchAgents,
  preflightLaunchAgentInstall,
  preflightLaunchAgentUninstall,
  uninstallLaunchAgents,
} from "../scripts/install-launchd.ts";
import {
  approveOnlineIphoneShortcut,
  clearOnlineIphoneCaptureToken,
  configureOnlineIphoneCapture,
  copyOnlineIphoneCaptureToken,
  disableIphoneCapture,
  disableOnlineIphoneCapture,
  iphoneCaptureStatus,
  onlineIphoneCaptureStatus,
} from "../scripts/configure-iphone.ts";
import {
  assertShortcutOfferAction,
  readShortcutOffer,
  SHORTCUT_FILE,
  shortcutQualification,
} from "../core/shortcut-offer.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function archiveArguments(): string[] {
  const args = process.argv.slice(2);
  const forwarded: string[] = [];
  let installRootSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--install-root") {
      forwarded.push(args[index]!);
      continue;
    }
    if (installRootSeen || !args[index + 1] || args[index + 1]!.startsWith("--")) {
      throw new Error("--install-root requires exactly one directory");
    }
    installRootSeen = true;
    index += 1;
  }
  return forwarded;
}

function installRoot(): string {
  return resolve(
    argument("--install-root") ??
      process.env.PAPERTRAIL_INSTALL_ROOT ??
      join(homedir(), "Library", "Application Support", "Papertrail", "app"),
  );
}

function sourceRoot(): string {
  const explicit = argument("--source");
  if (explicit) return resolve(explicit);
  const besideExecutable = dirname(process.execPath);
  if (existsSync(join(besideExecutable, ".papertrail-artifact.json"))) {
    return besideExecutable;
  }
  return dirname(import.meta.dir);
}

function client(value: string | undefined): AgentClient {
  if (value !== "codex" && value !== "hermes") {
    throw new Error("choose exactly one agent client: codex or hermes");
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function launchAgentsRoot(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

const ARCHIVE_COMMANDS = new Set([
  "capture",
  "recent",
  "search",
  "show",
  "health",
  "doctor",
  "rebuild",
]);

function printReady(
  root: string,
  dataRoot: string,
  verb: "installed" | "updated",
  preservedConfiguration: boolean,
): void {
  const command = join(root, "bin", "wordhold");
  console.log(`Wordhold ${verb}. Local archive ready.`);
  console.log(`Program: ${root}`);
  console.log(`Private data: ${dataRoot}`);
  console.log(
    preservedConfiguration
      ? "Existing configuration and optional-integration choices were preserved."
      : "Optional integrations remain disabled until you choose them.",
  );
  console.log(`Capture: ${shellQuote(command)} capture 'A note for Wordhold'`);
  console.log(`Archive queued work: ${shellQuote(command)} drain`);
  console.log(`Retrieve: ${shellQuote(command)} recent`);
  console.log(`Diagnose: ${shellQuote(command)} doctor`);
  console.log(`Connect an agent: ${shellQuote(command)} connect codex  # or hermes`);
}

function runInstalledDaemon(root: string, dataRoot: string): void {
  const current = join(root, "current");
  const result = Bun.spawnSync([join(current, "bin", "papertrail-daemon")], {
    env: {
      ...process.env,
      PAPERTRAIL_ROOT: dataRoot,
      PAPERTRAIL_APP_ROOT: current,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`Wordhold drain failed (${result.exitCode})`);
}

async function probeAgentIntegration(
  receipt: NonNullable<ReturnType<typeof installAgentIntegrations>>,
  selected: AgentClient,
): Promise<void> {
  const managed = receipt.managed[selected];
  if (!managed) throw new Error("agent integration receipt is incomplete");
  const probe = new Client({ name: "wordhold-setup", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: managed.expected.command,
    args: managed.expected.args,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...managed.expected.env,
    },
    stderr: "pipe",
  });
  try {
    await probe.connect(transport);
    const tools = (await probe.listTools()).tools.map((tool) => tool.name).sort();
    const expected = [
      "doctor",
      "get_item",
      "health",
      "queue_capture",
      "recent_items",
      "search_items",
    ];
    if (JSON.stringify(tools) !== JSON.stringify(expected)) {
      throw new Error("registered Wordhold server did not expose the six-tool contract");
    }
  } finally {
    await probe.close();
  }
}

export async function main(): Promise<void> {
  const command = process.argv[2];
  const root = installRoot();
  if (command && ARCHIVE_COMMANDS.has(command)) {
    const result = Bun.spawnSync(
      [join(root, "bin", "pt"), ...archiveArguments()],
      {
        env: process.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    process.exitCode = result.exitCode;
    return;
  }
  if (command === "setup") {
    const dataRoot = resolve(
      argument("--data-root") ??
        join(homedir(), "Library", "Application Support", "Papertrail", "data"),
    );
    const preservedConfiguration = existsSync(
      join(dataRoot, "papertrail.config.json"),
    );
    const result = installOrUpdate({
      sourceRoot: sourceRoot(),
      installRoot: root,
      dataRoot,
      failAfterStage: process.env.PAPERTRAIL_TEST_FAIL_AFTER_STAGE === "1",
    });
    printReady(root, dataRoot, "installed", preservedConfiguration);
    if (result.shortcutOffer === "repair_required") {
      console.log("Attention: the release is active, but the offered iPhone Shortcut digest could not be refreshed; rerun iphone setup before approving an import.");
    }
    return;
  }
  if (command === "update") {
    const updateSource = sourceRoot();
    const current = join(root, "current");
    const dataRoot = installedDataRoot(root);
    const scheduled = preflightLaunchAgentInstall(
      dataRoot,
      launchAgentsRoot(),
      current,
    );
    if (
      existsSync(current) &&
      realpathSync(updateSource) === realpathSync(current)
    ) {
      if (scheduled) {
        await installLaunchAgents(dataRoot, launchAgentsRoot(), current);
      }
      console.log("Wordhold is already on this release; no update was needed.");
      return;
    }
    const result = installOrUpdate({
      sourceRoot: updateSource,
      installRoot: root,
      failAfterStage: process.env.PAPERTRAIL_TEST_FAIL_AFTER_STAGE === "1",
    });
    // A prior reload may have failed after lifecycle activation. Reconcile an
    // owned schedule even when this exact release is already current so the
    // same update command is a safe repair operation.
    if (scheduled) {
      await installLaunchAgents(
        result.dataRoot,
        launchAgentsRoot(),
        join(root, "current"),
      );
    }
    if (result.changed) printReady(root, result.dataRoot, "updated", true);
    else console.log("Wordhold is already on this release; no update was needed.");
    if (result.shortcutOffer === "repair_required") {
      console.log("Attention: the release is active, but the offered iPhone Shortcut digest could not be refreshed; rerun iphone setup before approving an import.");
    }
    return;
  }
  if (command === "drain") {
    runInstalledDaemon(root, installedDataRoot(root));
    return;
  }
  if (command === "iphone") {
    const action = process.argv[3];
    const dataRoot = installedDataRoot(root);
    const offer = readShortcutOffer(sourceRoot());
    const shortcutPath = join(
      sourceRoot(),
      "integrations",
      "shortcuts",
      SHORTCUT_FILE,
    );
    if (action === "setup") {
      assertShortcutOfferAction(offer, "setup");
      const baseUrl = argument("--base-url");
      const keychainAccount = argument("--keychain-account");
      if (!baseUrl || !keychainAccount) {
        throw new Error(
          "iphone setup requires --base-url and --keychain-account",
        );
      }
      const result = await configureOnlineIphoneCapture({
        dataRoot,
        shortcutArtifact: shortcutPath,
        baseUrl,
        keychainAccount,
        keychainService: argument("--keychain-service"),
      });
      console.log(
        result.changed
          ? "The online iPhone client is configured and its capture-only credential was verified."
          : "The online iPhone client already matches this endpoint, credential reference, and Shortcut.",
      );
      console.log(`Import this owner-qualified Shortcut: ${shortcutPath}`);
      console.log(`Offered Shortcut SHA-256: ${result.shortcut.sha256}`);
      console.log(`First import answer: ${result.saveUrl}`);
      console.log(
          `For the second answer, run: ${shellQuote(join(root, "bin", "wordhold"))} iphone shortcut copy-token`,
      );
      console.log(
        `After importing it on the iPhone, run: ${shellQuote(join(root, "bin", "wordhold"))} iphone shortcut approve`,
      );
      console.log(
        "Setup verifies Mac-side configuration only; it does not claim the Shortcut is installed or has run on the phone.",
      );
      console.log(
        "The Papertrail name in this signed Shortcut is expected: it is the pre-rename compatibility client for this Wordhold archive.",
      );
      return;
    }
    if (action === "status") {
      const status = onlineIphoneCaptureStatus(dataRoot, shortcutPath);
      console.log(JSON.stringify({
        ...status,
        offerQualification: shortcutQualification(
          offer,
          status.shortcut === "approved",
        ),
        offerVersion: offer.version,
        workflowName: offer.workflowName,
        legacyIcloud: iphoneCaptureStatus(dataRoot),
      }));
      return;
    }
    if (action === "disable") {
      console.log(
        disableOnlineIphoneCapture(dataRoot)
          ? "The Mac's online iPhone client reference was removed. The phone Shortcut, Keychain item, Worker token, remote queue, legacy iCloud evidence, and corpus were not changed."
          : "Online iPhone capture was already unconfigured.",
      );
      return;
    }
    if (action === "shortcut") {
      const shortcutAction = process.argv[4];
      if (shortcutAction === "copy-token") {
        await copyOnlineIphoneCaptureToken(dataRoot);
        console.log(
          `The capture-only token is on the clipboard. Paste it into the Shortcut import prompt, then run: ${shellQuote(join(root, "bin", "wordhold"))} iphone shortcut clear-token`,
        );
        return;
      }
      if (shortcutAction === "clear-token") {
        const cleared = await clearOnlineIphoneCaptureToken(dataRoot);
        console.log(
          cleared
            ? "The capture token was cleared from the clipboard."
            : "The clipboard was not changed because it no longer exactly matches the current capture token.",
        );
        return;
      }
      if (shortcutAction !== "approve") {
        throw new Error(
          "usage: wordhold iphone shortcut <copy-token|clear-token|approve>",
        );
      }
      assertShortcutOfferAction(offer, "approve", {
        qualificationObserved: process.argv.includes("--qualified-live"),
      });
      const shortcut = approveOnlineIphoneShortcut(dataRoot, shortcutPath);
      console.log(
        `Recorded human approval for ${shortcut.file} (${shortcut.sha256}). This records the offered artifact, not live-device behavior.`,
      );
      return;
    }
    if (action === "legacy-icloud") {
      const legacyAction = process.argv[4];
      if (legacyAction === "status") {
        console.log(JSON.stringify(iphoneCaptureStatus(dataRoot)));
        return;
      }
      if (legacyAction === "disable") {
        const result = disableIphoneCapture(dataRoot);
        console.log(
          `Legacy local iCloud ingestion is disabled; queued evidence remains at ${result.inboxDir}. The phone and online client were not changed.`,
        );
        return;
      }
      throw new Error(
        "usage: wordhold iphone legacy-icloud <status|disable>",
      );
    }
    throw new Error(
      "usage: wordhold iphone <setup|status|disable|shortcut copy-token|shortcut clear-token|shortcut approve|legacy-icloud status|legacy-icloud disable>",
    );
  }
  if (command === "schedule") {
    const dataRoot = installedDataRoot(root);
    const paths = await installLaunchAgents(
      dataRoot,
      launchAgentsRoot(),
      join(root, "current"),
    );
    console.log(`Wordhold scheduling enabled with ${paths.length} owned launch agent(s).`);
    console.log(`Full Disk Access is needed only if Reading List is enabled: ${join(dataRoot, "dist", "papertrail-daemon")}`);
    return;
  }
  if (command === "unschedule") {
    const paths = await uninstallLaunchAgents(launchAgentsRoot());
    console.log(`Wordhold scheduling removed (${paths.length} launch agent(s)); private data preserved.`);
    return;
  }
  if (command === "connect") {
    const selected = client(process.argv[3]);
    const dataRoot = installedDataRoot(root);
    const prior = managedAgentClients(root);
    const receipt = installAgentIntegrations({
      appRoot: join(root, "current"),
      installRoot: root,
      dataRoot,
      clients: [selected],
    });
    if (!receipt) throw new Error("packaged agent integration receipt was not created");
    try {
      await probeAgentIntegration(receipt, selected);
    } catch (error) {
      if (!prior.includes(selected)) {
        try {
          removeAgentIntegrations({ installRoot: root, clients: [selected] });
        } catch {
          throw new Error(
            `agent connection probe failed and automatic rollback also failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      throw new Error(
        `agent connection probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    console.log(`Wordhold connected to ${selected} using the compatibility MCP key 'papertrail'.`);
    console.log(
      "The client/model provider may receive your question and selected bounded evidence.",
    );
    return;
  }
  if (command === "disconnect") {
    const selected = client(process.argv[3]);
    removeAgentIntegrations({ installRoot: root, clients: [selected] });
    console.log(`Wordhold disconnected from ${selected}; private data preserved.`);
    return;
  }
  if (command === "uninstall") {
    const program = preflightUninstallProgram(root);
    const launchd = preflightLaunchAgentUninstall(launchAgentsRoot());
    if (
      launchd.repoRoot !== null &&
      (!existsSync(launchd.repoRoot) || realpathSync(launchd.repoRoot) !== program.dataRoot)
    ) {
      throw new Error("Wordhold LaunchAgents belong to a different private data root");
    }
    if (launchd.paths.length) await uninstallLaunchAgents(launchAgentsRoot());
    const result = uninstallProgram(root);
    console.log(`Wordhold program removed. Private data preserved at ${result.dataRoot}`);
    console.log(
      "Phone Shortcuts, the remote Worker queue, and any legacy iCloud queue were not changed. Remove or revoke capture clients separately, or accepted captures can accumulate until Wordhold is reinstalled.",
    );
    return;
  }
  throw new Error(
    "usage: wordhold <capture|recent|search|show|health|doctor|rebuild|setup|update|drain|iphone|schedule|unschedule|connect codex|connect hermes|disconnect codex|disconnect hermes|uninstall> [--install-root DIR] [--data-root DIR]",
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`Wordhold: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
