import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { atomicWriteFile } from "../core/atomic.ts";
import { loadConfig } from "../core/config.ts";
import type { WordholdConfig } from "../core/types.ts";
import { safeWebUrl, workerOrigin } from "../core/web-url.ts";
import {
  classifyIphoneCaptureFile,
  isRejectedIphoneCaptureFile,
} from "../core/iphone-capture-file.ts";

type ExplicitConfig = WordholdConfig & {
  capabilities: NonNullable<WordholdConfig["capabilities"]>;
};
type IphoneState = NonNullable<WordholdConfig["iphoneCapture"]>;
type ShortcutIdentity = IphoneState["offeredShortcut"];
type OnlineIphoneState = NonNullable<WordholdConfig["iphoneOnline"]>;
type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ConfigureIphoneOptions {
  dataRoot: string;
  iCloudDocuments: string;
  shortcutArtifact: string;
}

export async function verifyCaptureOnlyWorker(options: {
  baseUrl: string;
  credential: string;
  fetchFn?: FetchFn;
  allowHttpForTest?: boolean;
}): Promise<{ status: "capture_only"; baseUrl: string }> {
  const baseUrl = workerOrigin(options.baseUrl, {
    allowHttp: options.allowHttpForTest,
    allowPrivate: options.allowHttpForTest,
  });
  if (!options.credential) throw new Error("capture credential is empty");
  const fetchFn = options.fetchFn ?? fetch;
  const auth = { authorization: `Bearer ${options.credential}` };
  const denied = "capture credential cannot access this route";
  const probes: Array<{
    method: "GET" | "POST";
    path: string;
    expected: 400 | 403;
    expectedError: string;
    body?: Record<string, unknown>;
  }> = [
    { method: "POST", path: "/v1/save", expected: 400, expectedError: "save url required", body: {} },
    { method: "POST", path: "/v1/highlight", expected: 400, expectedError: "highlight text required", body: {} },
    {
      method: "POST",
      path: "/v1/capture",
      expected: 400,
      expectedError: "note text required",
      body: { kind: "note", text: "" },
    },
    { method: "GET", path: "/v1/drain", expected: 403, expectedError: denied },
    { method: "GET", path: "/v1/body/probe", expected: 403, expectedError: denied },
    { method: "POST", path: "/v1/ack", expected: 403, expectedError: denied, body: { ids: [] } },
    {
      method: "POST",
      path: "/v1/allow",
      expected: 403,
      expectedError: denied,
      body: { address: "probe@invalid.example" },
    },
    { method: "POST", path: "/v1/sync-senders", expected: 403, expectedError: denied, body: {} },
  ];
  for (const probe of probes) {
    const response = await fetchFn(new URL(probe.path, `${baseUrl}/`), {
      method: probe.method,
      headers: {
        ...auth,
        ...(probe.body ? { "content-type": "application/json" } : {}),
      },
      ...(probe.body ? { body: JSON.stringify(probe.body) } : {}),
      redirect: "manual",
    });
    if (response.status !== probe.expected) {
      throw new Error(
        `capture-only verification failed at ${probe.path} (${response.status})`,
      );
    }
    let responseError: unknown;
    try {
      responseError = (await response.json() as { error?: unknown }).error;
    } catch {
      responseError = undefined;
    }
    if (responseError !== probe.expectedError) {
      throw new Error(
        `capture-only verification got an unexpected contract response at ${probe.path}`,
      );
    }
  }
  return { status: "capture_only", baseUrl };
}

function requireRealFile(path: string, label: string): void {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error(`${label} must be a real file`);
  }
}

function requireRealDirectory(path: string, label: string): void {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) {
    throw new Error(`${label} must be an existing real directory`);
  }
}

function readConfig(dataRoot: string): ExplicitConfig {
  const path = join(dataRoot, "papertrail.config.json");
  requireRealFile(path, "Wordhold config");
  const config = JSON.parse(readFileSync(path, "utf8")) as WordholdConfig;
  if (!config.capabilities || typeof config.icloudInboxDir !== "string") {
    throw new Error("iPhone setup requires an explicit-capability Wordhold config");
  }
  validateIphoneState(config.iphoneCapture);
  validateOnlineIphoneState(config.iphoneOnline);
  return config as ExplicitConfig;
}

function validShortcutIdentity(value: unknown): value is ShortcutIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.file === "string" &&
    identity.file === basename(identity.file) &&
    identity.file.endsWith(".shortcut") &&
    typeof identity.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(identity.sha256)
  );
}

function sameShortcutIdentity(
  left: ShortcutIdentity | null | undefined,
  right: ShortcutIdentity | null | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.file === right.file &&
      left.sha256 === right.sha256,
  );
}

function validWorkerVerification(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const worker = value as Record<string, unknown>;
  const credential = worker.credential;
  if (
    typeof worker.baseUrl !== "string" ||
    typeof worker.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(worker.verifiedAt)) ||
    typeof credential !== "object" ||
    credential === null ||
    Array.isArray(credential)
  ) {
    return false;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(worker.baseUrl);
  } catch {
    return false;
  }
  const reference = credential as Record<string, unknown>;
  return (
    endpoint.protocol === "https:" &&
    endpoint.origin === worker.baseUrl &&
    !endpoint.username &&
    !endpoint.password &&
    !endpoint.search &&
    !endpoint.hash &&
    reference.kind === "keychain" &&
    typeof reference.account === "string" &&
    reference.account.length > 0 &&
    typeof reference.service === "string" &&
    reference.service.length > 0
  );
}

function validateIphoneState(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("iPhone setup state is invalid");
  }
  const state = value as Record<string, unknown>;
  if (
    state.format !== 1 ||
    typeof state.inboxDir !== "string" ||
    !isAbsolute(state.inboxDir) ||
    resolve(state.inboxDir) !== state.inboxDir ||
    !validShortcutIdentity(state.offeredShortcut) ||
    (state.approvedShortcut !== undefined &&
      !validShortcutIdentity(state.approvedShortcut)) ||
    !validWorkerVerification(state.workerVerification)
  ) {
    throw new Error("iPhone setup state is invalid");
  }
}

function validateOnlineIphoneState(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("online iPhone setup state is invalid");
  }
  const state = value as Record<string, unknown>;
  if (
    state.format !== 1 ||
    !validShortcutIdentity(state.offeredShortcut) ||
    (state.approvedShortcut !== undefined &&
      !validShortcutIdentity(state.approvedShortcut)) ||
    state.workerVerification === undefined ||
    !validWorkerVerification(state.workerVerification)
  ) {
    throw new Error("online iPhone setup state is invalid");
  }
}

function writeConfig(dataRoot: string, config: ExplicitConfig): void {
  atomicWriteFile(
    join(dataRoot, "papertrail.config.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
}

function shortcutIdentity(path: string): ShortcutIdentity {
  requireRealFile(path, "exported Shortcut");
  const bytes = readFileSync(path);
  if (!path.endsWith(".shortcut") || bytes.byteLength === 0) {
    throw new Error("exported Shortcut must be a non-empty .shortcut file");
  }
  return {
    file: basename(path),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function matchingWorkerDrain(
  config: WordholdConfig,
  requestedBaseUrl: string,
): boolean {
  let requested: string;
  let configured: string;
  try {
    requested = workerOrigin(requestedBaseUrl);
    configured = workerOrigin(config.worker.baseUrl);
  } catch {
    return false;
  }
  const enabled = config.capabilities === undefined
    ? Boolean(config.worker.baseUrl && config.worker.secret)
    : config.capabilities.workerInbox;
  return Boolean(
    enabled &&
      config.worker.secret.trim() &&
      requested === configured,
  );
}

function requireMatchingWorkerDrain(
  config: WordholdConfig,
  requestedBaseUrl: string,
): void {
  if (!matchingWorkerDrain(config, requestedBaseUrl)) {
    throw new Error(
      "enable and resolve the matching Mac Worker inbox before configuring the online iPhone client",
    );
  }
}

async function verifyAdminWorkerDrain(options: {
  baseUrl: string;
  credential: string;
  fetchFn?: FetchFn;
}): Promise<void> {
  const baseUrl = workerOrigin(options.baseUrl);
  const response = await (options.fetchFn ?? fetch)(
    new URL("/v1/drain?limit=1&cursor=~", `${baseUrl}/`),
    {
      method: "GET",
      headers: { authorization: `Bearer ${options.credential}` },
      redirect: "manual",
    },
  );
  if (response.status !== 200) {
    throw new Error(
      `Mac Worker drain verification failed (${response.status})`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !Array.isArray((body as Record<string, unknown>).rows)
  ) {
    throw new Error("Mac Worker drain verification returned an invalid contract");
  }
  const rows = (body as { rows: unknown[] }).rows;
  const quarantinedRows = (body as { quarantinedRows?: unknown }).quarantinedRows;
  if (
    rows.length !== 0 ||
    (quarantinedRows !== undefined &&
      (!Array.isArray(quarantinedRows) || quarantinedRows.length !== 0))
  ) {
    throw new Error("Mac Worker drain verification exposed queued rows");
  }
}

export async function configureOnlineIphoneCapture(options: {
  dataRoot: string;
  shortcutArtifact: string;
  baseUrl: string;
  keychainAccount: string;
  keychainService?: string;
  resolveCredential?: (account: string, service: string) => string | Promise<string>;
  fetchFn?: FetchFn;
}): Promise<{
  changed: boolean;
  saveUrl: string;
  shortcut: ShortcutIdentity;
}> {
  const dataRoot = realpathSync(resolve(options.dataRoot));
  const config = readConfig(dataRoot);
  const runtimeConfig = loadConfig(dataRoot);
  requireMatchingWorkerDrain(runtimeConfig, options.baseUrl);
  await verifyAdminWorkerDrain({
    baseUrl: options.baseUrl,
    credential: runtimeConfig.worker.secret,
    fetchFn: options.fetchFn,
  });
  const shortcut = shortcutIdentity(resolve(options.shortcutArtifact));
  const account = options.keychainAccount.trim();
  const service = options.keychainService?.trim() || "papertrail-capture-secret";
  if (!account) throw new Error("Keychain account is required");
  const credential = await (options.resolveCredential ?? readKeychainCredential)(
    account,
    service,
  );
  const verified = await verifyCaptureOnlyWorker({
    baseUrl: options.baseUrl,
    credential,
    fetchFn: options.fetchFn,
  });
  const existing = config.iphoneOnline;
  const next: OnlineIphoneState = {
    format: 1,
    offeredShortcut: shortcut,
    // Running setup is also the supported credential-rotation entry point.
    // The installed phone answers are not inspectable from the Mac, so every
    // setup invalidates the prior human confirmation even when the Keychain
    // reference and generic Shortcut bytes are unchanged.
    workerVerification: {
      baseUrl: verified.baseUrl,
      verifiedAt: new Date().toISOString(),
      credential: { kind: "keychain", account, service },
    },
  };
  const changed = !existing ||
    Boolean(existing.approvedShortcut) ||
    !sameShortcutIdentity(existing.offeredShortcut, shortcut) ||
    existing.workerVerification.baseUrl !== verified.baseUrl ||
    existing.workerVerification.credential.account !== account ||
    existing.workerVerification.credential.service !== service;
  config.iphoneOnline = next;
  writeConfig(dataRoot, config);
  return {
    changed,
    saveUrl: `${verified.baseUrl}/v1/save`,
    shortcut,
  };
}

export function onlineIphoneCaptureStatus(
  rawDataRoot: string,
  currentShortcutArtifact?: string,
): {
  state: "disabled" | "ready" | "blocked";
  shortcut: "approval_required" | "approved" | "update_available" | "repair_required";
  worker: "unconfigured" | "capture_only_verified" | "drain_unconfigured";
  liveDevice: "unknown";
} {
  const dataRoot = realpathSync(resolve(rawDataRoot));
  const config = readConfig(dataRoot);
  const state = config.iphoneOnline;
  if (!state) {
    return {
      state: "disabled",
      shortcut: "approval_required",
      worker: "unconfigured",
      liveDevice: "unknown",
    };
  }
  const current = currentShortcutArtifact
    ? shortcutIdentity(resolve(currentShortcutArtifact))
    : null;
  const shortcut = current && !sameShortcutIdentity(current, state.offeredShortcut)
    ? "repair_required"
    : !state.approvedShortcut
      ? "approval_required"
      : sameShortcutIdentity(state.approvedShortcut, state.offeredShortcut)
        ? "approved"
        : "update_available";
  const drainReady = matchingWorkerDrain(
    loadConfig(dataRoot),
    state.workerVerification.baseUrl,
  );
  return {
    state: drainReady ? "ready" : "blocked",
    shortcut,
    worker: drainReady ? "capture_only_verified" : "drain_unconfigured",
    liveDevice: "unknown",
  };
}

export function approveOnlineIphoneShortcut(
  rawDataRoot: string,
  currentShortcutArtifact: string,
): ShortcutIdentity {
  const dataRoot = realpathSync(resolve(rawDataRoot));
  const config = readConfig(dataRoot);
  if (!config.iphoneOnline) {
    throw new Error("configure online iPhone capture first");
  }
  requireMatchingWorkerDrain(
    loadConfig(dataRoot),
    config.iphoneOnline.workerVerification.baseUrl,
  );
  const current = shortcutIdentity(resolve(currentShortcutArtifact));
  if (!sameShortcutIdentity(current, config.iphoneOnline.offeredShortcut)) {
    throw new Error("online Shortcut offer state needs repair before approval");
  }
  config.iphoneOnline.approvedShortcut = config.iphoneOnline.offeredShortcut;
  writeConfig(dataRoot, config);
  return config.iphoneOnline.approvedShortcut;
}

function writeSystemClipboard(value: string): void {
  const result = Bun.spawnSync(["/usr/bin/pbcopy"], {
    stdin: new TextEncoder().encode(value),
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error("could not copy the capture credential to the clipboard");
  }
}

function readSystemClipboard(): string {
  const result = Bun.spawnSync(["/usr/bin/pbpaste"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error("could not read the clipboard");
  }
  return new TextDecoder().decode(result.stdout);
}

export async function copyOnlineIphoneCaptureToken(
  rawDataRoot: string,
  options: {
    resolveCredential?: (account: string, service: string) => string | Promise<string>;
    fetchFn?: FetchFn;
    writeClipboard?: (value: string) => void | Promise<void>;
  } = {},
): Promise<void> {
  const dataRoot = realpathSync(resolve(rawDataRoot));
  const config = readConfig(dataRoot);
  const verification = config.iphoneOnline?.workerVerification;
  if (!verification) {
    throw new Error("configure online iPhone capture first");
  }
  const runtimeConfig = loadConfig(dataRoot);
  requireMatchingWorkerDrain(runtimeConfig, verification.baseUrl);
  await verifyAdminWorkerDrain({
    baseUrl: verification.baseUrl,
    credential: runtimeConfig.worker.secret,
    fetchFn: options.fetchFn,
  });
  const credential = await (options.resolveCredential ?? readKeychainCredential)(
    verification.credential.account,
    verification.credential.service,
  );
  await verifyCaptureOnlyWorker({
    baseUrl: verification.baseUrl,
    credential,
    fetchFn: options.fetchFn,
  });
  await (options.writeClipboard ?? writeSystemClipboard)(credential);
}

export async function clearOnlineIphoneCaptureToken(
  rawDataRoot: string,
  options: {
    resolveCredential?: (account: string, service: string) => string | Promise<string>;
    readClipboard?: () => string | Promise<string>;
    writeClipboard?: (value: string) => void | Promise<void>;
  } = {},
): Promise<boolean> {
  const dataRoot = realpathSync(resolve(rawDataRoot));
  const config = readConfig(dataRoot);
  const verification = config.iphoneOnline?.workerVerification;
  if (!verification) {
    throw new Error("configure online iPhone capture first");
  }
  const credential = await (options.resolveCredential ?? readKeychainCredential)(
    verification.credential.account,
    verification.credential.service,
  );
  const clipboard = await (options.readClipboard ?? readSystemClipboard)();
  if (clipboard !== credential) return false;
  await (options.writeClipboard ?? writeSystemClipboard)("");
  return true;
}

export function disableOnlineIphoneCapture(rawDataRoot: string): boolean {
  const dataRoot = realpathSync(resolve(rawDataRoot));
  const config = readConfig(dataRoot);
  if (!config.iphoneOnline) return false;
  delete config.iphoneOnline;
  writeConfig(dataRoot, config);
  return true;
}

export function refreshOnlineOfferedShortcut(
  rawDataRoot: string,
  shortcutArtifact: string,
): boolean {
  const dataRoot = realpathSync(resolve(rawDataRoot));
  const config = readConfig(dataRoot);
  if (!config.iphoneOnline) return false;
  const shortcut = shortcutIdentity(resolve(shortcutArtifact));
  if (sameShortcutIdentity(config.iphoneOnline.offeredShortcut, shortcut)) {
    return false;
  }
  config.iphoneOnline.offeredShortcut = shortcut;
  writeConfig(dataRoot, config);
  return true;
}

export function onlineOfferedShortcutRefreshNeeded(
  rawDataRoot: string,
  shortcutArtifact: string,
): boolean {
  const dataRoot = realpathSync(resolve(rawDataRoot));
  const configPath = join(dataRoot, "papertrail.config.json");
  requireRealFile(configPath, "Wordhold config");
  const preliminary = JSON.parse(
    readFileSync(configPath, "utf8"),
  ) as WordholdConfig;
  if (!preliminary.iphoneOnline) return false;
  const config = readConfig(dataRoot);
  if (!config.iphoneOnline) return false;
  const shortcut = shortcutIdentity(resolve(shortcutArtifact));
  return !sameShortcutIdentity(config.iphoneOnline.offeredShortcut, shortcut);
}

export function configureIphoneCapture(
  options: ConfigureIphoneOptions,
): {
  changed: boolean;
  inboxDir: string;
  shortcut: ShortcutIdentity;
  shortcutApprovalRequired: boolean;
} {
  const dataRoot = realpathSync(resolve(options.dataRoot));
  const config = readConfig(dataRoot);
  const rawDocuments = resolve(options.iCloudDocuments);
  requireRealDirectory(rawDocuments, "iCloud Shortcuts documents directory");
  const documents = realpathSync(rawDocuments);
  const inboxDir = join(documents, "Papertrail");
  if (
    existsSync(inboxDir) &&
    (lstatSync(inboxDir).isSymbolicLink() || !lstatSync(inboxDir).isDirectory())
  ) {
    throw new Error("Wordhold iCloud inbox must be a real directory");
  }
  const shortcut = shortcutIdentity(resolve(options.shortcutArtifact));
  const existing = config.iphoneCapture;
  if (config.icloudInboxDir && resolve(config.icloudInboxDir) !== inboxDir) {
    throw new Error("refusing to replace a differently configured iCloud inbox");
  }
  if (existing && existing.inboxDir !== inboxDir) {
    throw new Error("refusing to replace changed iPhone integration state");
  }
  const alreadyOffered = Boolean(
    existing &&
      existing.offeredShortcut.sha256 === shortcut.sha256 &&
      config.capabilities.icloudInbox &&
      config.icloudInboxDir === inboxDir,
  );
  if (alreadyOffered) {
    return {
      changed: false,
      inboxDir,
      shortcut,
      shortcutApprovalRequired: existing!.approvedShortcut?.sha256 !== shortcut.sha256,
    };
  }
  mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
  config.capabilities.icloudInbox = true;
  config.icloudInboxDir = inboxDir;
  config.iphoneCapture = {
    format: 1,
    inboxDir,
    offeredShortcut: shortcut,
    ...(existing?.approvedShortcut
      ? { approvedShortcut: existing.approvedShortcut }
      : {}),
    ...(existing?.workerVerification
      ? { workerVerification: existing.workerVerification }
      : {}),
  };
  writeConfig(dataRoot, config);
  return {
    changed: true,
    inboxDir,
    shortcut,
    shortcutApprovalRequired: config.iphoneCapture.approvedShortcut?.sha256 !== shortcut.sha256,
  };
}

export function approveOfferedShortcut(rawDataRoot: string): ShortcutIdentity {
  const dataRoot = realpathSync(resolve(rawDataRoot));
  const config = readConfig(dataRoot);
  if (!config.iphoneCapture) throw new Error("configure iCloud iPhone capture first");
  config.iphoneCapture.approvedShortcut = config.iphoneCapture.offeredShortcut;
  writeConfig(dataRoot, config);
  return config.iphoneCapture.approvedShortcut;
}

/** Refreshes only the offered artifact after a verified program update. */
export function refreshOfferedShortcut(
  rawDataRoot: string,
  shortcutArtifact: string,
): boolean {
  const dataRoot = realpathSync(resolve(rawDataRoot));
  const config = readConfig(dataRoot);
  if (!config.iphoneCapture) return false;
  const shortcut = shortcutIdentity(resolve(shortcutArtifact));
  if (
    config.iphoneCapture.offeredShortcut.file === shortcut.file &&
    config.iphoneCapture.offeredShortcut.sha256 === shortcut.sha256
  ) {
    return false;
  }
  config.iphoneCapture.offeredShortcut = shortcut;
  writeConfig(dataRoot, config);
  return true;
}

/** Read-only preflight used before an atomic program activation. */
export function offeredShortcutRefreshNeeded(
  rawDataRoot: string,
  shortcutArtifact: string,
): boolean {
  const dataRoot = realpathSync(resolve(rawDataRoot));
  const configPath = join(dataRoot, "papertrail.config.json");
  requireRealFile(configPath, "Wordhold config");
  const preliminary = JSON.parse(readFileSync(configPath, "utf8")) as WordholdConfig;
  // Pre-distribution corpora may not have explicit capability flags. They are
  // valid lifecycle inputs until iPhone management is explicitly requested.
  if (!preliminary.iphoneCapture) return false;
  const config = readConfig(dataRoot);
  if (!config.iphoneCapture) return false;
  const shortcut = shortcutIdentity(resolve(shortcutArtifact));
  return !(
    config.iphoneCapture.offeredShortcut.file === shortcut.file &&
    config.iphoneCapture.offeredShortcut.sha256 === shortcut.sha256
  );
}

export async function configureWorkerAcceleration(options: {
  dataRoot: string;
  baseUrl: string;
  keychainAccount: string;
  keychainService?: string;
  resolveCredential?: (account: string, service: string) => string | Promise<string>;
  fetchFn?: FetchFn;
}): Promise<{ status: "capture_only"; baseUrl: string }> {
  const dataRoot = realpathSync(resolve(options.dataRoot));
  const config = readConfig(dataRoot);
  if (!config.iphoneCapture) throw new Error("configure iCloud iPhone capture first");
  const account = options.keychainAccount.trim();
  const service = options.keychainService?.trim() || "papertrail-capture-secret";
  if (!account) throw new Error("Keychain account is required");
  const credential = await (options.resolveCredential ?? readKeychainCredential)(account, service);
  const verified = await verifyCaptureOnlyWorker({
    baseUrl: options.baseUrl,
    credential,
    fetchFn: options.fetchFn,
  });
  config.iphoneCapture.workerVerification = {
    baseUrl: verified.baseUrl,
    verifiedAt: new Date().toISOString(),
    credential: { kind: "keychain", account, service },
  };
  writeConfig(dataRoot, config);
  return verified;
}

export function readKeychainCredential(account: string, service: string): string {
  const result = Bun.spawnSync(
    ["/usr/bin/security", "find-generic-password", "-a", account, "-s", service, "-w"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error("capture credential was not found in macOS Keychain");
  }
  const credential = new TextDecoder().decode(result.stdout).trim();
  if (!credential) throw new Error("capture credential in macOS Keychain is empty");
  return credential;
}

export function disableWorkerAcceleration(rawDataRoot: string): boolean {
  const dataRoot = realpathSync(resolve(rawDataRoot));
  const config = readConfig(dataRoot);
  if (!config.iphoneCapture) throw new Error("Wordhold iPhone capture is not managed");
  if (!config.iphoneCapture.workerVerification) return false;
  delete config.iphoneCapture.workerVerification;
  writeConfig(dataRoot, config);
  return true;
}

export function iphoneCaptureStatus(rawDataRoot: string): {
  state: "disabled" | "unmanaged" | "ready" | "unavailable" | "changed";
  queue: "empty" | "queued" | "stale";
  queuedFiles: number;
  attention: "none" | "rejected_captures";
  rejectedFiles: number;
  shortcut: "approval_required" | "approved" | "update_available";
  worker: "unconfigured" | "reference_verified";
  liveDevice: "unknown";
} {
  const dataRoot = realpathSync(resolve(rawDataRoot));
  const config = readConfig(dataRoot);
  const rejectedDir = join(dataRoot, "logs", "bad-captures");
  const rejectedFiles = existsSync(rejectedDir) && lstatSync(rejectedDir).isDirectory()
    ? readdirSync(rejectedDir).filter(isRejectedIphoneCaptureFile).length
    : 0;
  const attention = rejectedFiles > 0 ? "rejected_captures" as const : "none" as const;
  const state = config.iphoneCapture;
  if (!state) {
    return {
      state: config.capabilities.icloudInbox || config.icloudInboxDir ? "unmanaged" : "disabled",
      queue: "empty",
      queuedFiles: 0,
      attention,
      rejectedFiles,
      shortcut: "approval_required",
      worker: "unconfigured",
      liveDevice: "unknown",
    };
  }
  const shortcut: "approval_required" | "approved" | "update_available" =
    !state.approvedShortcut
    ? "approval_required"
    : state.approvedShortcut.sha256 === state.offeredShortcut.sha256
    ? "approved"
    : "update_available";
  const common = {
    attention,
    rejectedFiles,
    shortcut,
    worker: state.workerVerification ? "reference_verified" as const : "unconfigured" as const,
    liveDevice: "unknown" as const,
  };
  if (!config.capabilities.icloudInbox || resolve(config.icloudInboxDir || "/") !== state.inboxDir) {
    return { state: "changed", queue: "empty", queuedFiles: 0, ...common };
  }
  if (
    !existsSync(state.inboxDir) ||
    lstatSync(state.inboxDir).isSymbolicLink() ||
    !lstatSync(state.inboxDir).isDirectory()
  ) {
    return { state: "unavailable", queue: "empty", queuedFiles: 0, ...common };
  }
  const paths = readdirSync(state.inboxDir)
    .filter((name) => classifyIphoneCaptureFile(name) !== null)
    .map((name) => join(state.inboxDir, name));
  const stale = paths.some((path) => Date.now() - statSync(path).mtimeMs > 15 * 60 * 1000);
  return {
    state: "ready",
    queue: stale ? "stale" : paths.length ? "queued" : "empty",
    queuedFiles: paths.length,
    ...common,
  };
}

export function disableIphoneCapture(rawDataRoot: string): { inboxDir: string } {
  const dataRoot = realpathSync(resolve(rawDataRoot));
  const config = readConfig(dataRoot);
  const state = config.iphoneCapture;
  if (!state) throw new Error("Wordhold iPhone capture is not managed");
  if (config.icloudInboxDir && resolve(config.icloudInboxDir) !== state.inboxDir) {
    throw new Error("refusing to disable changed iPhone integration state");
  }
  config.capabilities.icloudInbox = false;
  config.icloudInboxDir = "";
  delete config.iphoneCapture;
  writeConfig(dataRoot, config);
  return { inboxDir: state.inboxDir };
}
