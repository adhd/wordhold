import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDataRoot } from "../core/installation.ts";
import { handleFetch } from "../worker/src/index.ts";
import { FakeD1, FakeR2 } from "./helpers/worker-fakes.ts";
import {
  approveOnlineIphoneShortcut,
  clearOnlineIphoneCaptureToken,
  configureIphoneCapture,
  configureOnlineIphoneCapture,
  copyOnlineIphoneCaptureToken,
  disableOnlineIphoneCapture,
  iphoneCaptureStatus,
  onlineOfferedShortcutRefreshNeeded,
  onlineIphoneCaptureStatus,
  refreshOnlineOfferedShortcut,
} from "../scripts/configure-iphone.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function workerFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const path = url.pathname;
  const authorization = new Headers(
    input instanceof Request ? input.headers : init?.headers,
  ).get("authorization");
  if (path === "/v1/drain" && authorization === "Bearer admin-secret") {
    if (url.search !== "?limit=1&cursor=~") {
      return Promise.resolve(Response.json({ error: "unsafe admin probe" }, { status: 422 }));
    }
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

function enableWorkerDrain(dataRoot: string): void {
  const path = join(dataRoot, "papertrail.config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.capabilities.workerInbox = true;
  config.worker = {
    baseUrl: "https://worker.example",
    secret: "admin-secret",
  };
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

test("online iPhone setup refuses a Mac with no matching Worker drain", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-online-no-drain-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  const shortcutArtifact = join(root, "Save to Papertrail — Online.shortcut");
  writeFileSync(shortcutArtifact, "qualified online Shortcut fixture");

  await expect(configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact,
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "capture-secret-must-not-persist",
    fetchFn: workerFetch,
  })).rejects.toThrow("enable and resolve the matching Mac Worker inbox");
  expect(JSON.parse(
    readFileSync(join(dataRoot, "papertrail.config.json"), "utf8"),
  ).iphoneOnline).toBeUndefined();

  enableWorkerDrain(dataRoot);
  await expect(configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact,
    baseUrl: "https://different-worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "capture-secret-must-not-persist",
    fetchFn: workerFetch,
  })).rejects.toThrow("enable and resolve the matching Mac Worker inbox");
  expect(JSON.parse(
    readFileSync(join(dataRoot, "papertrail.config.json"), "utf8"),
  ).iphoneOnline).toBeUndefined();
}, 20_000);

test("online setup refuses an unresolved or unauthorized Mac drain credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-online-admin-guard-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  const configPath = join(dataRoot, "papertrail.config.json");
  const shortcutArtifact = join(root, "Save to Papertrail — Online.shortcut");
  writeFileSync(shortcutArtifact, "qualified online Shortcut fixture");

  const unresolved = JSON.parse(readFileSync(configPath, "utf8"));
  unresolved.capabilities.workerInbox = true;
  unresolved.worker = {
    baseUrl: "https://worker.example",
    secret: "env:PAPERTRAIL_UNSET_ADMIN_TEST",
  };
  writeFileSync(configPath, JSON.stringify(unresolved, null, 2) + "\n");
  await expect(configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact,
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "capture-token",
    fetchFn: workerFetch,
  })).rejects.toThrow("enable and resolve the matching Mac Worker inbox");

  unresolved.worker.secret = "wrong-admin-secret";
  writeFileSync(configPath, JSON.stringify(unresolved, null, 2) + "\n");
  await expect(configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact,
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "capture-token",
    fetchFn: workerFetch,
  })).rejects.toThrow("Mac Worker drain verification failed");
  expect(JSON.parse(readFileSync(configPath, "utf8")).iphoneOnline).toBeUndefined();
}, 20_000);

test("online iPhone setup records only a verified credential reference and qualified artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-online-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  enableWorkerDrain(dataRoot);
  const shortcutArtifact = join(root, "Save to Papertrail — Online.shortcut");
  writeFileSync(shortcutArtifact, "qualified online Shortcut fixture");

  const result = await configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact,
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "capture-secret-must-not-persist",
    fetchFn: workerFetch,
  });

  expect(result).toMatchObject({
    changed: true,
    saveUrl: "https://worker.example/v1/save",
    shortcut: { file: "Save to Papertrail — Online.shortcut" },
  });
  const configText = readFileSync(join(dataRoot, "papertrail.config.json"), "utf8");
  expect(configText).toContain("https://worker.example");
  expect(configText).toContain("recipient");
  expect(configText).toContain("papertrail-capture-secret");
  expect(configText).not.toContain("capture-secret-must-not-persist");
  expect(JSON.parse(configText).capabilities.icloudInbox).toBe(false);
  expect(onlineIphoneCaptureStatus(dataRoot)).toMatchObject({
    state: "ready",
    shortcut: "approval_required",
    worker: "capture_only_verified",
    liveDevice: "unknown",
  });

  const configPath = join(dataRoot, "papertrail.config.json");
  const drifted = JSON.parse(readFileSync(configPath, "utf8"));
  drifted.capabilities.workerInbox = false;
  writeFileSync(configPath, JSON.stringify(drifted, null, 2) + "\n");
  expect(onlineIphoneCaptureStatus(dataRoot)).toMatchObject({
    state: "blocked",
    worker: "drain_unconfigured",
  });
  drifted.capabilities.workerInbox = true;
  drifted.worker.baseUrl = "https://different-worker.example";
  writeFileSync(configPath, JSON.stringify(drifted, null, 2) + "\n");
  expect(onlineIphoneCaptureStatus(dataRoot)).toMatchObject({
    state: "blocked",
    worker: "drain_unconfigured",
  });
  for (const invalidBaseUrl of [
    "https://worker.example/subpath",
    "https://worker.example?tenant=wrong",
  ]) {
    drifted.worker.baseUrl = invalidBaseUrl;
    writeFileSync(configPath, JSON.stringify(drifted, null, 2) + "\n");
    expect(onlineIphoneCaptureStatus(dataRoot)).toMatchObject({
      state: "blocked",
      worker: "drain_unconfigured",
    });
  }
}, 20_000);

test("online setup rejects an admin drain response that exposes queued rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-online-drain-exposure-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  enableWorkerDrain(dataRoot);
  const shortcutArtifact = join(root, "Save to Papertrail — Online.shortcut");
  writeFileSync(shortcutArtifact, "qualified online Shortcut fixture");

  await expect(configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact,
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "capture-token",
    fetchFn: (input, init) => {
      const request = input instanceof Request
        ? input
        : new Request(String(input), init);
      if (
        new URL(request.url).pathname === "/v1/drain" &&
        request.headers.get("authorization") === "Bearer admin-secret"
      ) {
        return Promise.resolve(Response.json({
          rows: [{ id: "in_private", payload: { url: "https://private.example" } }],
          nextCursor: null,
        }));
      }
      return workerFetch(request);
    },
  })).rejects.toThrow("exposed queued rows");
  expect(JSON.parse(
    readFileSync(join(dataRoot, "papertrail.config.json"), "utf8"),
  ).iphoneOnline).toBeUndefined();
}, 20_000);

test("the exact admin readiness probe leaves live Worker queue and recovery state unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-online-worker-probe-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  enableWorkerDrain(dataRoot);
  const shortcutArtifact = join(root, "Save to Papertrail — Online.shortcut");
  writeFileSync(shortcutArtifact, "qualified online Shortcut fixture");

  const db = new FakeD1();
  db.rows.set("in_existing", {
    id: "in_existing",
    kind: "save",
    payload: JSON.stringify({ url: "https://example.com/already-queued" }),
    received_at: "2026-08-23T20:00:00.000Z",
    quarantined: 0,
  });
  const bodies = new FakeR2();
  const pendingId = "in_recovery_eligible";
  const pendingKey = `email-pending/${pendingId}.json`;
  await bodies.put(pendingKey, JSON.stringify({
    row: {
      id: pendingId,
      kind: "email",
      payload: { from: "writer@example.com", subject: "Pending", bodyKey: pendingKey },
      receivedAt: "2026-08-23T20:01:00.000Z",
      quarantined: 0,
    },
    body: { text: "must remain recovery-only" },
  }));
  const beforeRows = [...db.rows.entries()];
  const beforeObjects = [...bodies.objects.entries()];
  const adminProbeUrls: string[] = [];
  const env = {
    INBOX: db,
    BODIES: bodies,
    SECRET: "admin-secret",
    CAPTURE_SECRET: "capture-token",
  } as never;

  await configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact,
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "capture-token",
    fetchFn: async (input, init) => {
      const request = input instanceof Request
        ? input
        : new Request(String(input), init);
      if (request.headers.get("authorization") === "Bearer admin-secret") {
        adminProbeUrls.push(request.url);
      }
      return handleFetch(request, env);
    },
  });

  expect(adminProbeUrls).toEqual([
    "https://worker.example/v1/drain?limit=1&cursor=~",
  ]);
  expect([...db.rows.entries()]).toEqual(beforeRows);
  expect([...bodies.objects.entries()]).toEqual(beforeObjects);
}, 20_000);

test("online state requires Worker verification while legacy iCloud state may omit it", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-online-state-validation-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  const iCloudDocuments = join(root, "iCloud Shortcuts");
  mkdirSync(iCloudDocuments);
  const legacyShortcut = join(root, "Papertrail.shortcut");
  writeFileSync(legacyShortcut, "legacy fixture");
  configureIphoneCapture({ dataRoot, iCloudDocuments, shortcutArtifact: legacyShortcut });
  expect(iphoneCaptureStatus(dataRoot).state).toBe("ready");

  const configPath = join(dataRoot, "papertrail.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.iphoneOnline = {
    format: 1,
    offeredShortcut: {
      file: "Save to Papertrail — Online.shortcut",
      sha256: "a".repeat(64),
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  expect(() => onlineIphoneCaptureStatus(dataRoot)).toThrow(
    "online iPhone setup state is invalid",
  );
}, 20_000);

test("online Shortcut approval and clipboard copy stay bound to the configured offer", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-online-approval-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  enableWorkerDrain(dataRoot);
  const shortcutArtifact = join(root, "Save to Papertrail — Online.shortcut");
  writeFileSync(shortcutArtifact, "qualified online Shortcut fixture");
  await configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact,
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "setup-only-secret",
    fetchFn: workerFetch,
  });

  const approved = approveOnlineIphoneShortcut(dataRoot, shortcutArtifact);
  expect(approved.file).toBe("Save to Papertrail — Online.shortcut");
  expect(onlineIphoneCaptureStatus(dataRoot).shortcut).toBe("approved");

  let clipboard = "";
  const result = await copyOnlineIphoneCaptureToken(dataRoot, {
    resolveCredential: () => "clipboard-only-secret",
    fetchFn: workerFetch,
    writeClipboard: (value) => {
      clipboard = value;
    },
  });
  expect(result).toBeUndefined();
  expect(clipboard).toBe("clipboard-only-secret");
  expect(readFileSync(join(dataRoot, "papertrail.config.json"), "utf8"))
    .not.toContain("clipboard-only-secret");
}, 20_000);

test("running setup again invalidates approval so rotated phone answers cannot look current", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-online-rotation-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  enableWorkerDrain(dataRoot);
  const shortcutArtifact = join(root, "Save to Papertrail — Online.shortcut");
  writeFileSync(shortcutArtifact, "qualified online Shortcut fixture");
  const setup = {
    dataRoot,
    shortcutArtifact,
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    fetchFn: workerFetch,
  };
  await configureOnlineIphoneCapture({
    ...setup,
    resolveCredential: () => "capture-token-v1",
  });
  approveOnlineIphoneShortcut(dataRoot, shortcutArtifact);
  expect(onlineIphoneCaptureStatus(dataRoot).shortcut).toBe("approved");

  const repeated = await configureOnlineIphoneCapture({
    ...setup,
    resolveCredential: () => "capture-token-v2",
  });
  expect(repeated.changed).toBe(true);
  expect(onlineIphoneCaptureStatus(dataRoot).shortcut).toBe("approval_required");
}, 20_000);

test("token copy re-verifies the current Keychain value before touching the clipboard", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-online-copy-guard-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  enableWorkerDrain(dataRoot);
  const shortcutArtifact = join(root, "Save to Papertrail — Online.shortcut");
  writeFileSync(shortcutArtifact, "qualified online Shortcut fixture");
  await configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact,
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "capture-only-at-setup",
    fetchFn: workerFetch,
  });

  let clipboardTouched = false;
  await expect(copyOnlineIphoneCaptureToken(dataRoot, {
    resolveCredential: () => "changed-to-admin-credential",
    fetchFn: async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      const authorization = new Headers(
        input instanceof Request ? input.headers : init?.headers,
      ).get("authorization");
      if (path === "/v1/drain" && authorization === "Bearer admin-secret") {
        return Response.json({ rows: [], nextCursor: null });
      }
      if (["/v1/save", "/v1/highlight", "/v1/capture"].includes(path)) {
        return workerFetch(input, init);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    writeClipboard: () => {
      clipboardTouched = true;
    },
  })).rejects.toThrow("capture-only verification failed");
  expect(clipboardTouched).toBe(false);
}, 20_000);

test("clipboard clear removes only the exact current Keychain capture credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-online-clear-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  enableWorkerDrain(dataRoot);
  const shortcutArtifact = join(root, "Save to Papertrail — Online.shortcut");
  writeFileSync(shortcutArtifact, "qualified online Shortcut fixture");
  await configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact,
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "capture-token",
    fetchFn: workerFetch,
  });

  let clipboard = "capture-token";
  expect(await clearOnlineIphoneCaptureToken(dataRoot, {
    resolveCredential: () => "capture-token",
    readClipboard: () => clipboard,
    writeClipboard: (value) => {
      clipboard = value;
    },
  })).toBe(true);
  expect(clipboard).toBe("");

  clipboard = "unrelated clipboard contents";
  let writeAttempted = false;
  expect(await clearOnlineIphoneCaptureToken(dataRoot, {
    resolveCredential: () => "capture-token",
    readClipboard: () => clipboard,
    writeClipboard: () => {
      writeAttempted = true;
    },
  })).toBe(false);
  expect(clipboard).toBe("unrelated clipboard contents");
  expect(writeAttempted).toBe(false);
}, 20_000);

test("online Shortcut identity includes both filename and SHA-256", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-online-identity-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  enableWorkerDrain(dataRoot);
  const offered = join(root, "Save to Papertrail — Online.shortcut");
  const renamed = join(root, "Renamed Online.shortcut");
  writeFileSync(offered, "identical Shortcut bytes");
  writeFileSync(renamed, "identical Shortcut bytes");
  await configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact: offered,
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "capture-token",
    fetchFn: workerFetch,
  });
  approveOnlineIphoneShortcut(dataRoot, offered);

  expect(onlineIphoneCaptureStatus(dataRoot, renamed).shortcut).toBe(
    "repair_required",
  );
  expect(() => approveOnlineIphoneShortcut(dataRoot, renamed)).toThrow(
    "offer state needs repair",
  );
  expect(onlineOfferedShortcutRefreshNeeded(dataRoot, renamed)).toBe(true);
  expect(refreshOnlineOfferedShortcut(dataRoot, renamed)).toBe(true);
  expect(onlineIphoneCaptureStatus(dataRoot).shortcut).toBe("update_available");

  expect(refreshOnlineOfferedShortcut(dataRoot, offered)).toBe(true);
  const reconfigured = await configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact: renamed,
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "capture-token",
    fetchFn: workerFetch,
  });
  expect(reconfigured.changed).toBe(true);
  const config = JSON.parse(
    readFileSync(join(dataRoot, "papertrail.config.json"), "utf8"),
  );
  expect(config.iphoneOnline.offeredShortcut.file).toBe("Renamed Online.shortcut");
  expect(config.iphoneOnline.approvedShortcut).toBeUndefined();
}, 20_000);

test("disabling the online client preserves legacy iCloud recovery state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-online-disable-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  enableWorkerDrain(dataRoot);
  const iCloudDocuments = join(root, "iCloud Shortcuts");
  mkdirSync(iCloudDocuments);
  const legacyShortcut = join(root, "Papertrail.shortcut");
  writeFileSync(legacyShortcut, "legacy recovery fixture");
  configureIphoneCapture({ dataRoot, iCloudDocuments, shortcutArtifact: legacyShortcut });

  const onlineShortcut = join(root, "Save to Papertrail — Online.shortcut");
  writeFileSync(onlineShortcut, "qualified online Shortcut fixture");
  await configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact: onlineShortcut,
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "setup-only-secret",
    fetchFn: workerFetch,
  });

  expect(disableOnlineIphoneCapture(dataRoot)).toBe(true);
  expect(disableOnlineIphoneCapture(dataRoot)).toBe(false);
  expect(onlineIphoneCaptureStatus(dataRoot).state).toBe("disabled");
  expect(iphoneCaptureStatus(dataRoot).state).toBe("ready");
  const config = JSON.parse(
    readFileSync(join(dataRoot, "papertrail.config.json"), "utf8"),
  );
  expect(config.capabilities.icloudInbox).toBe(true);
  expect(config.iphoneCapture).toBeDefined();
  expect(config.iphoneOnline).toBeUndefined();
}, 20_000);

test("program updates refresh only the offered online artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-online-refresh-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  enableWorkerDrain(dataRoot);
  const first = join(root, "Save to Papertrail — Online.shortcut");
  const next = join(root, "next", "Save to Papertrail — Online.shortcut");
  mkdirSync(join(root, "next"));
  writeFileSync(first, "qualified online Shortcut v1");
  writeFileSync(next, "qualified online Shortcut v2");
  await configureOnlineIphoneCapture({
    dataRoot,
    shortcutArtifact: first,
    baseUrl: "https://worker.example",
    keychainAccount: "recipient",
    resolveCredential: () => "setup-only-secret",
    fetchFn: workerFetch,
  });
  const approved = approveOnlineIphoneShortcut(dataRoot, first);

  expect(onlineIphoneCaptureStatus(dataRoot, next).shortcut).toBe(
    "repair_required",
  );
  expect(() => approveOnlineIphoneShortcut(dataRoot, next)).toThrow(
    "offer state needs repair",
  );
  expect(onlineOfferedShortcutRefreshNeeded(dataRoot, next)).toBe(true);
  expect(refreshOnlineOfferedShortcut(dataRoot, next)).toBe(true);
  expect(onlineOfferedShortcutRefreshNeeded(dataRoot, next)).toBe(false);
  expect(onlineIphoneCaptureStatus(dataRoot).shortcut).toBe("update_available");
  const config = JSON.parse(
    readFileSync(join(dataRoot, "papertrail.config.json"), "utf8"),
  );
  expect(config.iphoneOnline.approvedShortcut.sha256).toBe(approved.sha256);
  expect(config.iphoneOnline.offeredShortcut.sha256).not.toBe(approved.sha256);
}, 20_000);
