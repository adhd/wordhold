// iMessage delivery. dryRun writes to logs/outbox.log; live mode drives
// Messages.app via osascript. Alerts never throw (they must not kill the daemon).
import { join } from "node:path";
import { log } from "../core/log.ts";
import { appendPrivateFile } from "../core/private-fs.ts";
import type { WordholdConfig } from "../core/types.ts";

export class SetupNeededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupNeededError";
  }
}

export interface SendResult {
  sent: boolean;
  dryRun: boolean;
}

export type OsaRunner = (
  args: string[],
) => Promise<{ exitCode: number; stderr: string }>;

// Recipient and text ride in as argv so no AppleScript string escaping is needed.
const SEND_SCRIPT = `on run argv
  tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy (item 1 of argv) of targetService
    send (item 2 of argv) to targetBuddy
  end tell
end run`;

const spawnOsascript: OsaRunner = async (args) => {
  const proc = Bun.spawn(["osascript", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr };
};

export async function sendIMessage(
  repoRoot: string,
  config: WordholdConfig,
  text: string,
  deps: { runner?: OsaRunner } = {},
): Promise<SendResult> {
  if (config.imessage.dryRun) {
    appendPrivateFile(
      join(repoRoot, "logs", "outbox.log"),
      `[${new Date().toISOString()}] to ${config.imessage.recipient}\n${text}\n\n`,
    );
    return { sent: false, dryRun: true };
  }
  const runner = deps.runner ?? spawnOsascript;
  const { exitCode, stderr } = await runner([
    "-e",
    SEND_SCRIPT,
    config.imessage.recipient,
    text,
  ]);
  if (exitCode === 0) return { sent: true, dryRun: false };
  if (/-1743|not allowed|not authorized/i.test(stderr)) {
    throw new SetupNeededError(
      "iMessage automation blocked (-1743): System Settings > Privacy & Security > Automation > enable Messages for the app running the daemon, then rerun",
    );
  }
  throw new Error(`osascript send failed (exit ${exitCode}): ${stderr.trim()}`);
}

export async function sendAlert(
  repoRoot: string,
  config: WordholdConfig,
  text: string,
  deps: { runner?: OsaRunner } = {},
): Promise<SendResult> {
  try {
    return await sendIMessage(
      repoRoot,
      config,
      "Wordhold alert: " + text,
      deps,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(repoRoot, "imessage", `alert not delivered: ${msg}`);
    return { sent: false, dryRun: config.imessage.dryRun };
  }
}
