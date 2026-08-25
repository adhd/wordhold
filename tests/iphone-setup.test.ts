import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDataRoot } from "../core/installation.ts";
import {
  approveOfferedShortcut,
  configureIphoneCapture,
  configureWorkerAcceleration,
  disableWorkerAcceleration,
  disableIphoneCapture,
  iphoneCaptureStatus,
  refreshOfferedShortcut,
  verifyCaptureOnlyWorker,
} from "../scripts/configure-iphone.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("iPhone setup owns configuration but preserves the iCloud queue on disable", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-setup-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  const iCloudDocuments = join(root, "iCloud Shortcuts");
  mkdirSync(iCloudDocuments);
  const shortcutArtifact = join(root, "Papertrail.shortcut");
  writeFileSync(shortcutArtifact, "reviewed Shortcut fixture");

  const first = configureIphoneCapture({
    dataRoot,
    iCloudDocuments,
    shortcutArtifact,
  });
  expect(first.changed).toBe(true);
  expect(first.inboxDir).toBe(join(realpathSync(iCloudDocuments), "Papertrail"));
  const config = JSON.parse(readFileSync(join(dataRoot, "papertrail.config.json"), "utf8"));
  expect(config.capabilities.icloudInbox).toBe(true);
  expect(config.icloudInboxDir).toBe(first.inboxDir);
  expect(config.iphoneCapture).toMatchObject({
    format: 1,
    inboxDir: first.inboxDir,
    offeredShortcut: { file: "Papertrail.shortcut" },
  });
  expect(config.iphoneCapture.approvedShortcut).toBeUndefined();
  expect(first.shortcutApprovalRequired).toBe(true);
  expect(iphoneCaptureStatus(dataRoot)).toMatchObject({
    shortcut: "approval_required",
    liveDevice: "unknown",
  });
  approveOfferedShortcut(dataRoot);
  expect(iphoneCaptureStatus(dataRoot)).toMatchObject({ shortcut: "approved" });
  expect(configureIphoneCapture({
    dataRoot,
    iCloudDocuments,
    shortcutArtifact,
  }).changed).toBe(false);

  const queued = join(first.inboxDir, "papertrail-preserved.json");
  writeFileSync(queued, '{"kind":"note","text":"preserve me"}\n');
  expect(iphoneCaptureStatus(dataRoot)).toMatchObject({
    state: "ready",
    queue: "queued",
    queuedFiles: 1,
    attention: "none",
    rejectedFiles: 0,
    worker: "unconfigured",
  });
  const rejectedDir = join(dataRoot, "logs", "bad-captures");
  mkdirSync(rejectedDir, { recursive: true });
  writeFileSync(join(rejectedDir, "papertrail-rejected.json"), "{ invalid");
  expect(iphoneCaptureStatus(dataRoot)).toMatchObject({
    attention: "rejected_captures",
    rejectedFiles: 1,
  });
  const queuedLink = join(
    first.inboxDir,
    "papertrail-link-0.3.7-123456789-987654321.txt",
  );
  writeFileSync(queuedLink, '{"kind":"save","url":"https://example.com"}\n');
  writeFileSync(join(first.inboxDir, "papertrail-unrelated.txt"), "untouched\n");
  writeFileSync(
    join(
      rejectedDir,
      "papertrail-link-0.3.7-111111111-222222222.txt.1",
    ),
    "{ invalid",
  );
  expect(iphoneCaptureStatus(dataRoot)).toMatchObject({
    queue: "queued",
    queuedFiles: 2,
    attention: "rejected_captures",
    rejectedFiles: 2,
  });
  const disabled = disableIphoneCapture(dataRoot);
  expect(disabled.inboxDir).toBe(first.inboxDir);
  expect(existsSync(queued)).toBe(true);
  const after = JSON.parse(readFileSync(join(dataRoot, "papertrail.config.json"), "utf8"));
  expect(after.capabilities.icloudInbox).toBe(false);
  expect(after.icloudInboxDir).toBe("");
  expect(after.iphoneCapture).toBeUndefined();
  expect(iphoneCaptureStatus(dataRoot)).toMatchObject({ state: "disabled" });
});

test("a changed Shortcut remains update-available until a human records approval", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-update-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  const iCloudDocuments = join(root, "iCloud Shortcuts");
  mkdirSync(iCloudDocuments);
  const shortcutArtifact = join(root, "Papertrail.shortcut");
  writeFileSync(shortcutArtifact, "reviewed Shortcut version one");
  configureIphoneCapture({ dataRoot, iCloudDocuments, shortcutArtifact });
  const approvedV1 = approveOfferedShortcut(dataRoot);

  writeFileSync(shortcutArtifact, "reviewed Shortcut version two");
  const update = configureIphoneCapture({
    dataRoot,
    iCloudDocuments,
    shortcutArtifact,
  });
  expect(update.changed).toBe(true);
  expect(update.shortcutApprovalRequired).toBe(true);
  expect(iphoneCaptureStatus(dataRoot)).toMatchObject({
    shortcut: "update_available",
    liveDevice: "unknown",
  });
  const config = JSON.parse(
    readFileSync(join(dataRoot, "papertrail.config.json"), "utf8"),
  );
  expect(config.iphoneCapture.approvedShortcut.sha256).toBe(approvedV1.sha256);
  expect(config.iphoneCapture.offeredShortcut.sha256).not.toBe(approvedV1.sha256);

  approveOfferedShortcut(dataRoot);
  expect(iphoneCaptureStatus(dataRoot)).toMatchObject({ shortcut: "approved" });
});

test("a verified program update refreshes only the offered Shortcut identity", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-refresh-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  const iCloudDocuments = join(root, "iCloud Shortcuts");
  mkdirSync(iCloudDocuments);
  const v1 = join(root, "Papertrail.shortcut");
  const v2 = join(root, "release", "Papertrail.shortcut");
  mkdirSync(join(root, "release"));
  writeFileSync(v1, "reviewed Shortcut version one");
  writeFileSync(v2, "reviewed Shortcut version two");
  configureIphoneCapture({ dataRoot, iCloudDocuments, shortcutArtifact: v1 });
  const approved = approveOfferedShortcut(dataRoot);
  const queue = join(realpathSync(iCloudDocuments), "Papertrail", "papertrail-queued.json");
  writeFileSync(queue, '{"kind":"note","text":"preserve queue"}\n');

  expect(refreshOfferedShortcut(dataRoot, v2)).toBe(true);
  expect(iphoneCaptureStatus(dataRoot)).toMatchObject({
    shortcut: "update_available",
    queue: "queued",
    queuedFiles: 1,
  });
  let config = JSON.parse(readFileSync(join(dataRoot, "papertrail.config.json"), "utf8"));
  expect(config.iphoneCapture.approvedShortcut.sha256).toBe(approved.sha256);
  expect(config.iphoneCapture.offeredShortcut.sha256).not.toBe(approved.sha256);
  expect(readFileSync(queue, "utf8")).toContain("preserve queue");
  approveOfferedShortcut(dataRoot);
  expect(iphoneCaptureStatus(dataRoot)).toMatchObject({ shortcut: "approved" });
  expect(refreshOfferedShortcut(dataRoot, v2)).toBe(false);
  config = JSON.parse(readFileSync(join(dataRoot, "papertrail.config.json"), "utf8"));
  expect(config.iphoneCapture.approvedShortcut).toEqual(config.iphoneCapture.offeredShortcut);
});

test("iPhone setup refuses a symlinked iCloud documents boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-symlink-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  const actualDocuments = join(root, "actual-documents");
  mkdirSync(actualDocuments);
  const linkedDocuments = join(root, "linked-documents");
  symlinkSync(actualDocuments, linkedDocuments);
  const shortcutArtifact = join(root, "Papertrail.shortcut");
  writeFileSync(shortcutArtifact, "reviewed Shortcut fixture");

  expect(() => configureIphoneCapture({
    dataRoot,
    iCloudDocuments: linkedDocuments,
    shortcutArtifact,
  })).toThrow("must be an existing real directory");
});

test("malformed ignored iPhone state fails with one bounded configuration error", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-invalid-state-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  const configPath = join(dataRoot, "papertrail.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.iphoneCapture = { format: 1 };
  writeFileSync(configPath, JSON.stringify(config));

  expect(() => iphoneCaptureStatus(dataRoot)).toThrow(
    "iPhone setup state is invalid",
  );
});

test("Worker verification proves capture-only authority without enqueueing", async () => {
  const requests: Array<{ path: string; authorization: string; body: string }> = [];
  const result = await verifyCaptureOnlyWorker({
    baseUrl: "https://worker.example",
    credential: "capture-only-value",
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        path: url.pathname,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: typeof init?.body === "string" ? init.body : "",
      });
      const captureErrors: Record<string, string> = {
        "/v1/save": "save url required",
        "/v1/highlight": "highlight text required",
        "/v1/capture": "note text required",
      };
      return new Response(
        JSON.stringify({
          error: captureErrors[url.pathname] ??
            "capture credential cannot access this route",
        }),
        { status: ["/v1/save", "/v1/highlight", "/v1/capture"].includes(url.pathname) ? 400 : 403 },
      );
    },
  });

  expect(result).toEqual({ status: "capture_only", baseUrl: "https://worker.example" });
  expect(requests.map((request) => request.path)).toEqual([
    "/v1/save",
    "/v1/highlight",
    "/v1/capture",
    "/v1/drain",
    "/v1/body/probe",
    "/v1/ack",
    "/v1/allow",
    "/v1/sync-senders",
  ]);
  expect(requests.every((request) =>
    request.authorization === "Bearer capture-only-value"
  )).toBe(true);
  expect(requests.slice(0, 3).map((request) => request.body)).toEqual([
    "{}",
    "{}",
    '{"kind":"note","text":""}',
  ]);
});

test("Worker verification rejects a status-only impostor", async () => {
  await expect(verifyCaptureOnlyWorker({
    baseUrl: "https://worker.example",
    credential: "capture-only-value",
    fetchFn: async (input) => {
      const path = new URL(String(input)).pathname;
      return new Response("{}", {
        status: ["/v1/save", "/v1/highlight", "/v1/capture"].includes(path)
          ? 400
          : 403,
      });
    },
  })).rejects.toThrow("unexpected contract response");
});

test("Worker verification accepts only a credential-free HTTPS origin", async () => {
  const fetchFn = async () => {
    throw new Error("invalid endpoints must fail before network access");
  };
  for (const baseUrl of [
    "http://worker.example",
    "https://user:password@worker.example",
    "https://worker.example/subpath",
    "https://worker.example?token=value",
    "https://worker.example/#private",
  ]) {
    await expect(verifyCaptureOnlyWorker({
      baseUrl,
      credential: "capture-only-value",
      fetchFn,
    })).rejects.toThrow(/public HTTPS origin|origin without credentials, path, query, or fragment/);
  }
});

test("optional Worker setup stores only its Keychain reference and is independently removable", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-iphone-worker-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  initializeDataRoot(dataRoot);
  const iCloudDocuments = join(root, "iCloud Shortcuts");
  mkdirSync(iCloudDocuments);
  const shortcutArtifact = join(root, "Papertrail.shortcut");
  writeFileSync(shortcutArtifact, "reviewed Shortcut fixture");
  configureIphoneCapture({ dataRoot, iCloudDocuments, shortcutArtifact });

  const fetchFn = async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const captureErrors: Record<string, string> = {
      "/v1/save": "save url required",
      "/v1/highlight": "highlight text required",
      "/v1/capture": "note text required",
    };
    return new Response(JSON.stringify({
      error: captureErrors[path] ?? "capture credential cannot access this route",
    }), {
      status: ["/v1/save", "/v1/highlight", "/v1/capture"].includes(path)
        ? 400
        : 403,
    });
  };
  await configureWorkerAcceleration({
    dataRoot,
    baseUrl: "https://worker.example",
    keychainAccount: "installation-123",
    resolveCredential: () => "never-persist-this-value",
    fetchFn,
  });
  const configPath = join(dataRoot, "papertrail.config.json");
  const configured = readFileSync(configPath, "utf8");
  expect(configured).toContain("https://worker.example");
  expect(configured).toContain("installation-123");
  expect(configured).toContain("papertrail-capture-secret");
  expect(configured).not.toContain("never-persist-this-value");
  expect(iphoneCaptureStatus(dataRoot)).toMatchObject({
    worker: "reference_verified",
    liveDevice: "unknown",
  });

  disableWorkerAcceleration(dataRoot);
  const disabled = readFileSync(configPath, "utf8");
  expect(disabled).not.toContain("worker.example");
  const config = JSON.parse(readFileSync(join(dataRoot, "papertrail.config.json"), "utf8"));
  expect(config.capabilities.icloudInbox).toBe(true);
});
