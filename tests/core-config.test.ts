import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityMode, loadConfig, resolveRepoRoot } from "../core/config.ts";

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["PT_TEST_SECRET", "PAPERTRAIL_DRY_RUN", "PAPERTRAIL_ROOT"];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pt-config-"));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const exampleConfig = {
  capabilities: {
    workerInbox: true,
    icloudInbox: true,
    readingList: true,
    enrichment: true,
    digest: true,
    resurfacing: true,
  },
  worker: {
    baseUrl: "https://w.example.workers.dev",
    secret: "env:PT_TEST_SECRET",
  },
  icloudInboxDir:
    "~/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents",
  readingListPlist: "~/Library/Safari/Bookmarks.plist",
  imessage: { recipient: "someone@example.com", dryRun: false },
  enrichment: { minBodyChars: 600, maxFetchAttempts: 5 },
};

function writeExample(cfg: unknown = exampleConfig) {
  writeFileSync(
    join(tmp, "papertrail.config.example.json"),
    JSON.stringify(cfg),
  );
}

function writeMain(cfg: unknown = exampleConfig) {
  writeFileSync(join(tmp, "papertrail.config.json"), JSON.stringify(cfg));
}

test("example config is never executable fallback state", () => {
  writeExample();
  expect(() => loadConfig(tmp)).toThrow("papertrail.config.json is missing");
});

test("papertrail.config.json wins over the example", () => {
  writeExample();
  writeFileSync(
    join(tmp, "papertrail.config.json"),
    JSON.stringify({
      ...exampleConfig,
      enrichment: { minBodyChars: 100, maxFetchAttempts: 2 },
    }),
  );
  const cfg = loadConfig(tmp);
  expect(cfg.enrichment.minBodyChars).toBe(100);
  expect(cfg.enrichment.maxFetchAttempts).toBe(2);
});

test("explicitly disabled placeholder integrations fail closed", () => {
  writeFileSync(
    join(tmp, "papertrail.config.json"),
    JSON.stringify({
      ...exampleConfig,
      capabilities: {
        workerInbox: false,
        icloudInbox: false,
        readingList: false,
        enrichment: false,
        digest: false,
        resurfacing: false,
      },
      worker: { baseUrl: "", secret: "" },
      icloudInboxDir: "",
      readingListPlist: "",
      imessage: { recipient: "", dryRun: true },
    }),
  );
  const cfg = loadConfig(tmp);
  expect(cfg.capabilities?.workerInbox).toBe(false);
  expect(cfg.worker.baseUrl).toBe("");
  expect(cfg.imessage).toEqual({ recipient: "", dryRun: true });
});

test("enabled placeholders remain unconfigured rather than executable", () => {
  writeMain({
    ...exampleConfig,
    worker: { baseUrl: "", secret: "" },
    imessage: { recipient: "", dryRun: true },
  });
  const cfg = loadConfig(tmp);
  expect(capabilityMode(cfg, "workerInbox")).toBe("unconfigured");
  expect(capabilityMode(cfg, "digest")).toBe("unconfigured");
  expect(capabilityMode(cfg, "enrichment")).toBe("enabled");
});

test("expands leading ~ in paths", () => {
  writeMain();
  const cfg = loadConfig(tmp);
  expect(cfg.icloudInboxDir.startsWith(homedir())).toBe(true);
  expect(cfg.icloudInboxDir.startsWith("~")).toBe(false);
  expect(cfg.readingListPlist).toBe(
    join(homedir(), "Library/Safari/Bookmarks.plist"),
  );
});

test("resolves env: secret from process.env", () => {
  writeMain();
  process.env.PT_TEST_SECRET = "from-process-env";
  const cfg = loadConfig(tmp);
  expect(cfg.worker.secret).toBe("from-process-env");
});

test("resolves env: secret from repoRoot/.env when process.env lacks it", () => {
  writeMain();
  writeFileSync(join(tmp, ".env"), '# comment\nPT_TEST_SECRET="from-dotenv"\n');
  const cfg = loadConfig(tmp);
  expect(cfg.worker.secret).toBe("from-dotenv");
});

test("PAPERTRAIL_DRY_RUN=1 forces imessage.dryRun", () => {
  writeMain();
  process.env.PAPERTRAIL_DRY_RUN = "1";
  const cfg = loadConfig(tmp);
  expect(cfg.imessage.dryRun).toBe(true);
});

test("resolveRepoRoot honors PAPERTRAIL_ROOT, else the package root", () => {
  process.env.PAPERTRAIL_ROOT = tmp;
  expect(resolveRepoRoot()).toBe(tmp);
  delete process.env.PAPERTRAIL_ROOT;
  expect(existsSync(join(resolveRepoRoot(), "package.json"))).toBe(true);
});
