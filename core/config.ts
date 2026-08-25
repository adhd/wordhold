// Central runtime config boundary. Populated config and .env stay ignored;
// env:NAME references resolve lazily from the process or repo-local .env.
// launchd sets PAPERTRAIL_ROOT because import.meta.dir is inside Bun's virtual
// filesystem in the compiled FDA-sensitive daemon.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { WordholdConfig } from "./types.ts";

export function resolveRepoRoot(): string {
  return process.env.PAPERTRAIL_ROOT || dirname(import.meta.dir);
}

export function resolveAppRoot(): string {
  return process.env.PAPERTRAIL_APP_ROOT || dirname(import.meta.dir);
}

function parseDotEnv(repoRoot: string): Record<string, string> {
  const p = join(repoRoot, ".env");
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(
      line,
    );
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function transform(
  value: unknown,
  dotEnv: () => Record<string, string>,
): unknown {
  if (typeof value === "string") {
    const env = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    if (env) return process.env[env[1]] ?? dotEnv()[env[1]] ?? "";
    if (value === "~" || value.startsWith("~/"))
      return join(homedir(), value.slice(1));
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => transform(v, dotEnv));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = transform(v, dotEnv);
    return out;
  }
  return value;
}

export function loadConfig(repoRoot: string): WordholdConfig {
  const main = join(repoRoot, "papertrail.config.json");
  if (!existsSync(main)) {
    throw new Error(
      `papertrail.config.json is missing in ${repoRoot}; run the local initializer before starting jobs`,
    );
  }
  let cached: Record<string, string> | null = null;
  const dotEnv = () => (cached ??= parseDotEnv(repoRoot));
  const raw = JSON.parse(readFileSync(main, "utf8"));
  const config = transform(raw, dotEnv) as WordholdConfig;
  if (process.env.PAPERTRAIL_DRY_RUN === "1") config.imessage.dryRun = true;
  return config;
}

export type OptionalCapability = keyof NonNullable<
  WordholdConfig["capabilities"]
>;
export type CapabilityMode = "disabled" | "unconfigured" | "enabled";

const REQUIRED: Record<OptionalCapability, (config: WordholdConfig) => boolean> = {
  workerInbox: (config) => Boolean(config.worker.baseUrl.trim() && config.worker.secret.trim()),
  icloudInbox: (config) => Boolean(config.icloudInboxDir.trim()),
  readingList: (config) => Boolean(config.readingListPlist.trim()),
  enrichment: () => true,
  digest: (config) => Boolean(config.imessage.recipient.trim()),
  resurfacing: (config) => Boolean(config.imessage.recipient.trim()),
};

/**
 * Legacy configs predate capability flags and remain enabled. New configs are
 * explicit, so a placeholder can never silently turn on an external edge.
 */
export function capabilityMode(
  config: WordholdConfig,
  capability: OptionalCapability,
): CapabilityMode {
  if (config.capabilities === undefined) return "enabled";
  if (!config.capabilities[capability]) return "disabled";
  return REQUIRED[capability](config) ? "enabled" : "unconfigured";
}
