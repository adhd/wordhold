import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, searchFts } from "../core/db.ts";
import { structuredItem, structuredSearch } from "../core/query.ts";
import { readItem } from "../core/store.ts";
import type { WordholdConfig, SourceAdapter } from "../core/types.ts";
import { createIcloudInboxAdapter } from "../daemon/adapters/icloud-inbox.ts";
import { createLocalCaptureAdapter } from "../daemon/adapters/local-capture.ts";
import { createReadingListAdapter } from "../daemon/adapters/reading-list.ts";
import {
  createWorkerInboxAdapter,
  type WorkerInboxRow,
} from "../daemon/adapters/worker-inbox.ts";
import { runDaemonOnce } from "../daemon/main.ts";
import { handleFetch } from "../worker/src/index.ts";
import { FakeD1, FakeR2 } from "./helpers/worker-fakes.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function makeRepo(): { root: string; config: WordholdConfig; inbox: string } {
  const root = mkdtempSync(join(tmpdir(), "pt-daemon-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Papertrail Test");
  git(root, "config", "user.email", "papertrail@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "test corpus\n");
  writeFileSync(join(root, ".gitignore"), "papertrail.db*\ninbox/\nlogs/*.log\n");
  git(root, "add", "README.md", ".gitignore");
  git(root, "commit", "-qm", "baseline");
  const inbox = join(root, "icloud");
  mkdirSync(inbox);
  const config: WordholdConfig = {
    worker: { baseUrl: "", secret: "" },
    icloudInboxDir: inbox,
    readingListPlist: join(root, "Bookmarks.plist"),
    imessage: { recipient: "test", dryRun: true },
    enrichment: { minBodyChars: 100, maxFetchAttempts: 3 },
  };
  return { root, config, inbox };
}

test("0.3.7 iOS text handoff commits, retrieves, acknowledges, and converges on replay", async () => {
  const { root, config, inbox } = makeRepo();
  const filename = "papertrail-link-0.3.7-123456789-987654321.txt";
  const capturePath = join(inbox, filename);
  const handoff = JSON.stringify({
    kind: "save",
    url: "https://example.com/papertrail-link-recovery",
    buildMarker: "papertrail-link-0.3.7",
  });
  writeFileSync(capturePath, handoff);
  const article = `<html><head><title>Papertrail Link Recovery</title></head><body><article><p>${
    "Candidate recovery tracer phrase with enough substantive article text. ".repeat(20)
  }</p></article></body></html>`;

  const result = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [createIcloudInboxAdapter()],
    fetchFn: async () =>
      new Response(article, {
        headers: { "content-type": "text/html" },
      }),
  });

  expect(result).toMatchObject({ pulled: 1, processed: 1, acked: 1, errors: 0 });
  expect(existsSync(capturePath)).toBe(false);
  expect([...new Bun.Glob("inbox/raw/*.json").scanSync({ cwd: root })]).toEqual(
    [],
  );
  const db = openDb(root);
  const row = db.query("SELECT id, status, md_path FROM items").get() as {
    id: string;
    status: string;
    md_path: string;
  };
  expect(row.status).toBe("has_body");
  expect(readItem(root, row.md_path).body.length).toBeGreaterThan(100);
  const search = structuredSearch(db, {
    query: "candidate recovery tracer",
    sources: ["shortcut"],
  });
  expect(search).toMatchObject({
    operation: "search",
    count: 1,
    hits: [{
      id: row.id,
      url: "https://example.com/papertrail-link-recovery",
      sources: ["shortcut"],
    }],
  });
  expect(structuredItem(root, db, { id: row.id, maxChars: 500 })).toMatchObject({
    operation: "get",
    item: {
      id: row.id,
      url: "https://example.com/papertrail-link-recovery",
      sources: ["shortcut"],
      bodyAvailable: true,
    },
  });
  db.close();
  expect(git(root, "log", "-1", "--pretty=%s")).toBe(
    "daemon: drain 1 capture",
  );
  expect(git(root, "status", "--short", "--", "items")).toBe("");

  writeFileSync(capturePath, handoff);
  const replay = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [createIcloudInboxAdapter()],
    fetchFn: async () => {
      throw new Error("same immutable handoff must not refetch");
    },
  });
  expect(replay).toMatchObject({ pulled: 1, processed: 1, acked: 1, errors: 0 });
  expect(existsSync(capturePath)).toBe(false);
  const replayDb = openDb(root);
  expect((replayDb.query("SELECT COUNT(*) AS count FROM items").get() as { count: number }).count)
    .toBe(1);
  replayDb.close();
});

test("online Shortcut-shaped save receipts drain, commit, acknowledge, and retrieve", async () => {
  const { root, config } = makeRepo();
  config.worker = {
    baseUrl: "https://worker.example",
    secret: "worker-admin",
  };
  const inbox = new FakeD1();
  const env = {
    INBOX: inbox,
    BODIES: new FakeR2(),
    SECRET: "worker-admin",
    CAPTURE_SECRET: "phone-capture-only",
  } as never;

  const accepted = await handleFetch(
    new Request("https://worker.example/v1/save", {
      method: "POST",
      headers: {
        authorization: "Bearer phone-capture-only",
        "content-type": "application/json",
      },
      // This is the complete body emitted by the qualified online Shortcut.
      body: JSON.stringify({ url: "https://example.com/online-shortcut-proof" }),
    }),
    env,
  );
  expect(accepted.status).toBe(200);
  const receipt = (await accepted.json()) as { id: string };
  expect(receipt.id).toMatch(/^in_/);
  expect(inbox.rows.has(receipt.id)).toBe(true);

  const worker = createWorkerInboxAdapter({
    fetchFn: (input, init) =>
      handleFetch(new Request(input, init), env),
  });
  const article = `<html><head><title>Online Shortcut Proof</title></head><body><article><p>${
    "A qualified one URL receipt becomes locally retrievable evidence. ".repeat(20)
  }</p></article></body></html>`;
  const result = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [worker],
    fetchFn: async () =>
      new Response(article, { headers: { "content-type": "text/html" } }),
  });
  expect(result).toMatchObject({ pulled: 1, processed: 1, acked: 1, errors: 0 });
  expect(inbox.rows.has(receipt.id)).toBe(false);
  expect([...new Bun.Glob("inbox/raw/*.json").scanSync({ cwd: root })]).toEqual([]);
  expect(git(root, "log", "-1", "--pretty=%s")).toBe("daemon: drain 1 capture");

  const db = openDb(root);
  const search = structuredSearch(db, {
    query: "qualified one URL receipt",
    sources: ["shortcut"],
  });
  expect(search).toMatchObject({
    operation: "search",
    count: 1,
    hits: [{
      url: "https://example.com/online-shortcut-proof",
      sources: ["shortcut"],
      bodyAvailable: true,
    }],
  });
  const itemId = search.hits[0]!.id;
  expect(structuredItem(root, db, { id: itemId, maxChars: 500 })).toMatchObject({
    operation: "get",
    item: {
      id: itemId,
      url: "https://example.com/online-shortcut-proof",
      sources: ["shortcut"],
      bodyAvailable: true,
    },
  });
  db.close();
});

test("canonical corruption preserves last-good reads and blocks daemon mutation until repaired", async () => {
  const { root, config } = makeRepo();
  const seed: SourceAdapter = {
    name: "worker_inbox",
    pull: async () => [
      {
        kind: "note",
        source: "shortcut",
        text: "Last-good searchable daemon evidence.",
        capturedAt: "2026-08-05T12:30:00.000Z",
        idempotencyKey: "last-good-daemon-1",
      },
    ],
    ack: async () => undefined,
  };
  await runDaemonOnce({ repoRoot: root, config, adapters: [seed] });
  let db = openDb(root);
  const row = db.query("SELECT id, md_path FROM items").get() as {
    id: string;
    md_path: string;
  };
  db.close();
  const canonicalPath = join(root, row.md_path);
  const validCanonical = readFileSync(canonicalPath, "utf8");
  writeFileSync(
    canonicalPath,
    "---\nid: pt_broken\nhighlight_count: 1\n---\nprivate broken body marker\n",
  );
  let pulled = false;
  let acknowledged = false;
  const guarded: SourceAdapter = {
    name: "worker_inbox",
    pull: async () => {
      pulled = true;
      return [];
    },
    ack: async () => {
      acknowledged = true;
    },
  };

  const failed = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [guarded],
  });

  expect(failed).toMatchObject({ pulled: 0, processed: 0, acked: 0, errors: 1 });
  expect(pulled).toBe(false);
  expect(acknowledged).toBe(false);
  db = openDb(root);
  expect(searchFts(db, "daemon evidence").map((hit) => hit.itemId)).toEqual([
    row.id,
  ]);
  expect(
    db
      .query("SELECT last_error FROM source_health WHERE source = 'job:daemon'")
      .get(),
  ).toMatchObject({
    last_error: expect.stringContaining(row.md_path),
  });
  db.close();

  writeFileSync(canonicalPath, validCanonical);
  const recovered = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [guarded],
  });
  expect(recovered.errors).toBe(0);
  db = openDb(root);
  expect(
    db
      .query("SELECT last_success_at, last_error FROM source_health WHERE source = 'job:daemon'")
      .get(),
  ).toMatchObject({ last_success_at: expect.any(String), last_error: null });
  db.close();
});

test("an offline Shortcut file drains even while the Worker entrance fails", async () => {
  const { root, config, inbox } = makeRepo();
  const capturePath = join(inbox, "papertrail-offline-save.json");
  writeFileSync(
    capturePath,
    JSON.stringify({
      kind: "save",
      url: "https://example.com/offline-share",
      title: "Offline share",
      capturedAt: "2026-08-04T16:00:00.000Z",
      idempotencyKey: "offline-share-1",
    }),
  );
  const workerFailure: SourceAdapter = {
    name: "worker_inbox",
    pull: async () => {
      throw new Error("simulated phone network failure");
    },
  };
  const article = readFileSync(
    join(import.meta.dir, "fixtures", "extract", "article.html"),
    "utf8",
  );

  const result = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [workerFailure, createIcloudInboxAdapter()],
    fetchFn: async () =>
      new Response(article, { headers: { "content-type": "text/html" } }),
  });

  expect(result).toMatchObject({ pulled: 1, processed: 1, acked: 1, errors: 1 });
  expect(existsSync(capturePath)).toBe(false);
  expect([...new Bun.Glob("inbox/raw/*.json").scanSync({ cwd: root })]).toEqual([]);
  expect(git(root, "log", "-1", "--pretty=%s")).toBe("daemon: drain 1 capture");
  const db = openDb(root);
  expect(db.query("SELECT status FROM items").get()).toMatchObject({
    status: "has_body",
  });
  db.close();
});

test("a corrupt raw record degrades health while an independent capture commits and acknowledges", async () => {
  const { root, config } = makeRepo();
  const rawDir = join(root, "inbox", "raw");
  mkdirSync(rawDir, { recursive: true });
  const corruptId = "f".repeat(64);
  const corruptPath = join(rawDir, `${corruptId}.json`);
  const corruptBytes = "{ still not valid JSON\n";
  writeFileSync(corruptPath, corruptBytes);
  const acked: string[] = [];
  let pulls = 0;
  const adapter: SourceAdapter = {
    name: "worker_inbox",
    pull: async () =>
      pulls++ === 0
        ? [
            {
              kind: "note",
              source: "shortcut",
              text: "Independent valid capture after corrupt spool evidence.",
              capturedAt: "2026-08-05T13:00:00.000Z",
              idempotencyKey: "valid-upstream-1",
            },
          ]
        : [],
    ack: async (_ctx, captures) => {
      acked.push(...captures.map((capture) => capture.idempotencyKey ?? ""));
    },
  };

  const result = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [adapter],
  });

  expect(result).toMatchObject({ processed: 1, acked: 1, errors: 1 });
  expect(acked).toEqual(["valid-upstream-1"]);
  expect(readFileSync(corruptPath, "utf8")).toBe(corruptBytes);
  const db = openDb(root);
  expect(
    (db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n,
  ).toBe(1);
  expect(
    db
      .query("SELECT last_error FROM source_health WHERE source = 'raw_spool'")
      .get(),
  ).toMatchObject({ last_error: expect.stringContaining(`${corruptId}.json`) });
  db.close();
  expect(git(root, "log", "-1", "--pretty=%s")).toBe(
    "daemon: drain 1 capture",
  );

  writeFileSync(
    corruptPath,
    JSON.stringify({
      version: 1,
      adapterName: "worker_inbox",
      capture: {
        kind: "note",
        source: "shortcut",
        text: "Reviewed correction of the preserved malformed record.",
        capturedAt: "2026-08-05T13:01:00.000Z",
        idempotencyKey: "corrected-upstream-1",
      },
    }),
  );
  const recovered = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [adapter],
  });
  expect(recovered).toMatchObject({ processed: 1, acked: 1, errors: 0 });
  expect(acked).toEqual(["valid-upstream-1", "corrected-upstream-1"]);
  expect(existsSync(corruptPath)).toBe(false);
  const recoveredDb = openDb(root);
  expect(
    recoveredDb
      .query("SELECT last_error FROM source_health WHERE source = 'raw_spool'")
      .get(),
  ).toEqual({ last_error: null });
  expect(
    (recoveredDb.query("SELECT COUNT(*) AS n FROM items").get() as { n: number })
      .n,
  ).toBe(2);
  recoveredDb.close();

  const replay = await runDaemonOnce({ repoRoot: root, config, adapters: [adapter] });
  expect(replay).toMatchObject({ processed: 0, acked: 0, errors: 0 });
  expect(acked).toEqual(["valid-upstream-1", "corrected-upstream-1"]);
});

test("a pt capture receipt drains through the canonical transaction and git commit", async () => {
  const { root, config } = makeRepo();
  const cli = Bun.spawnSync(
    ["bun", join(import.meta.dir, "..", "cli", "pt.ts"), "capture", "--json"],
    {
      env: { ...process.env, PAPERTRAIL_ROOT: root },
      stdin: new TextEncoder().encode(
        JSON.stringify({
          input: "Agent context https://example.com/local-agent",
          capturedAt: "2026-08-04T16:00:00Z",
          idempotencyKey: "hermes-capture-1",
        }),
      ),
    },
  );
  expect(cli.exitCode).toBe(0);

  const article = readFileSync(
    join(import.meta.dir, "fixtures", "extract", "article.html"),
    "utf8",
  );
  const result = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [createLocalCaptureAdapter()],
    fetchFn: async () =>
      new Response(article, { headers: { "content-type": "text/html" } }),
  });

  expect(result).toMatchObject({ pulled: 0, processed: 1, acked: 1, errors: 0 });
  expect([...new Bun.Glob("inbox/raw/*.json").scanSync({ cwd: root })]).toEqual([]);
  const db = openDb(root);
  const row = db.query("SELECT md_path FROM items").get() as { md_path: string };
  const file = readItem(root, row.md_path);
  expect(file.frontmatter.capture_contexts[0]?.source).toBe("local_capture");
  expect(file.body.length).toBeGreaterThan(100);
  db.close();
  expect(git(root, "log", "-1", "--pretty=%s")).toBe("daemon: drain 1 capture");
});

test("a daemon drain commits to its corpus despite hostile ambient Git state", async () => {
  const { root, config } = makeRepo();
  writeFileSync(
    join(root, "papertrail.config.json"),
    JSON.stringify({
      ...config,
      capabilities: {
        workerInbox: false,
        icloudInbox: false,
        readingList: false,
        enrichment: false,
        digest: false,
        resurfacing: false,
      },
    }),
  );
  const decoy = mkdtempSync(join(tmpdir(), "pt-daemon-git-decoy-"));
  roots.push(decoy);
  git(decoy, "init", "-q");
  git(decoy, "config", "user.name", "Papertrail Test");
  git(decoy, "config", "user.email", "papertrail@example.invalid");
  git(decoy, "config", "commit.gpgsign", "false");
  writeFileSync(join(decoy, "README.md"), "decoy repository\n");
  git(decoy, "add", "README.md");
  git(decoy, "commit", "-qm", "decoy baseline");

  const hooks = join(decoy, "hostile-hooks");
  mkdirSync(hooks);
  const hookMarker = join(decoy, "hook-ran");
  const hook = join(hooks, "pre-commit");
  writeFileSync(hook, `#!/bin/sh\ntouch "${hookMarker}"\nexit 1\n`);
  chmodSync(hook, 0o755);
  const localHook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(localHook, `#!/bin/sh\ntouch "${hookMarker}"\nexit 1\n`);
  chmodSync(localHook, 0o755);
  const excludes = join(decoy, "hostile-excludes");
  writeFileSync(excludes, "items/\n");
  const globalConfig = join(decoy, "hostile.gitconfig");
  writeFileSync(
    globalConfig,
    `[core]\n\thooksPath = ${hooks}\n\texcludesFile = ${excludes}\n`,
  );

  const capture = Bun.spawnSync(
    [
      "bun",
      join(import.meta.dir, "..", "cli", "pt.ts"),
      "capture",
      "Runtime Git isolation keeps this capture in the intended corpus.",
    ],
    { env: { ...process.env, PAPERTRAIL_ROOT: root } },
  );
  expect(capture.exitCode).toBe(0);

  const drain = Bun.spawnSync(
    ["bun", join(import.meta.dir, "..", "daemon", "main.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        PAPERTRAIL_ROOT: root,
        GIT_DIR: join(decoy, ".git"),
        GIT_WORK_TREE: decoy,
        GIT_INDEX_FILE: join(decoy, ".git", "index"),
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_SYSTEM: globalConfig,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: hooks,
      },
    },
  );

  expect(drain.exitCode).toBe(0);
  expect([
    ...new Bun.Glob("inbox/raw/*.json").scanSync({ cwd: root }),
  ]).toEqual([]);
  expect(git(root, "log", "-1", "--pretty=%s")).toBe(
    "daemon: drain 1 capture",
  );
  expect(git(root, "ls-files", "items")).not.toBe("");
  expect(git(decoy, "log", "-1", "--pretty=%s")).toBe("decoy baseline");
  expect(existsSync(hookMarker)).toBe(false);
});

test("the same Shortcut save through Worker and iCloud becomes one item and one context", async () => {
  const { root, config, inbox } = makeRepo();
  const filePath = join(inbox, "papertrail-shared-save.json");
  const payload = {
    kind: "save" as const,
    url: "https://example.com/two-entrances",
    title: "Two entrances",
    text: "Shared from X with useful surrounding context.",
    capturedAt: "2026-08-04T16:00:00.000Z",
  };
  writeFileSync(filePath, JSON.stringify(payload));
  let workerAcked = false;
  const worker: SourceAdapter = {
    name: "worker_inbox",
    pull: async () => [
      {
        ...payload,
        source: "shortcut",
        idempotencyKey: "worker-row-1",
      },
    ],
    ack: async () => {
      workerAcked = true;
    },
  };
  const article = readFileSync(
    join(import.meta.dir, "fixtures", "extract", "article.html"),
    "utf8",
  );
  const result = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [worker, createIcloudInboxAdapter()],
    fetchFn: async () =>
      new Response(article, { headers: { "content-type": "text/html" } }),
  });
  expect(result).toMatchObject({ pulled: 2, processed: 2, acked: 2, errors: 0 });
  expect(workerAcked).toBe(true);
  expect(existsSync(filePath)).toBe(false);

  const db = openDb(root);
  expect(
    (db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n,
  ).toBe(1);
  const row = db.query("SELECT md_path FROM items").get() as { md_path: string };
  expect(readItem(root, row.md_path).frontmatter.capture_contexts).toHaveLength(1);
  db.close();
});

test("the same Shortcut note through Worker and iCloud becomes one canonical note", async () => {
  const { root, config, inbox } = makeRepo();
  const filePath = join(inbox, "papertrail-shared-note.json");
  const payload = {
    kind: "note" as const,
    text: "A thought captured once and delivered through two transports.",
    capturedAt: "2026-08-04T16:00:00.000Z",
    idempotencyKey: "shared-note-identity",
  };
  writeFileSync(filePath, JSON.stringify(payload));
  const worker: SourceAdapter = {
    name: "worker_inbox",
    pull: async () => [{ ...payload, source: "shortcut" }],
    ack: async () => undefined,
  };

  const result = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [worker, createIcloudInboxAdapter()],
  });
  expect(result).toMatchObject({ pulled: 2, processed: 2, acked: 2, errors: 0 });
  expect(existsSync(filePath)).toBe(false);

  const db = openDb(root);
  expect(
    (db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n,
  ).toBe(1);
  const row = db.query("SELECT md_path FROM items").get() as { md_path: string };
  expect(readItem(root, row.md_path).frontmatter.capture_contexts).toHaveLength(1);
  expect(searchFts(db, "thought")).toEqual([
    expect.objectContaining({ itemId: expect.any(String) }),
  ]);
  db.close();
});

test("a Shortcut Safari selection attaches exact manual text to its URL item", async () => {
  const { root, config, inbox } = makeRepo();
  const selected = "The passage selected with deliberate attention.";
  writeFileSync(
    join(inbox, "papertrail-001-save.json"),
    JSON.stringify({
      kind: "save",
      url: "https://example.com/selected",
      title: "Selected article",
      capturedAt: "2026-08-04T16:00:00.000Z",
    }),
  );
  writeFileSync(
    join(inbox, "papertrail-002-highlight.json"),
    JSON.stringify({
      kind: "highlight",
      url: "https://example.com/selected",
      title: "Selected article",
      text: selected,
      capturedAt: "2026-08-04T16:01:00.000Z",
    }),
  );
  const article = readFileSync(
    join(import.meta.dir, "fixtures", "extract", "article.html"),
    "utf8",
  );
  const result = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [createIcloudInboxAdapter()],
    fetchFn: async () =>
      new Response(article, { headers: { "content-type": "text/html" } }),
  });
  expect(result).toMatchObject({ pulled: 2, processed: 2, acked: 2, errors: 0 });
  const db = openDb(root);
  const row = db.query("SELECT md_path FROM items").get() as { md_path: string };
  expect(readItem(root, row.md_path).highlights).toEqual([
    expect.objectContaining({ origin: "manual", text: selected }),
  ]);
  db.close();
});

test("Worker/iCloud save, note, and highlight converge in both orders, the same pass, and replay", async () => {
  const { root, config, inbox } = makeRepo();
  config.worker = { baseUrl: "https://worker.example", secret: "worker-admin" };
  type PhoneCapture = {
    kind: "save" | "highlight" | "note";
    url?: string;
    title?: string;
    text: string;
    capturedAt: string;
    idempotencyKey: string;
  };
  const group = (suffix: string): PhoneCapture[] => {
    const url = `https://example.com/two-paths-${suffix}`;
    return [
      {
        kind: "save",
        url,
        title: `Two path article ${suffix}`,
        text: `Surrounding context ${suffix} preserved once.`,
        capturedAt: "2026-08-04T17:00:00.000Z",
        idempotencyKey: `ios-${suffix}-save`,
      },
      {
        kind: "note",
        text: `URL-less thought ${suffix} preserved once.`,
        capturedAt: "2026-08-04T17:01:00.000Z",
        idempotencyKey: `ios-${suffix}-note`,
      },
      {
        kind: "highlight",
        url,
        title: `Two path article ${suffix}`,
        text: `Exact selected passage ${suffix} arrives once.`,
        capturedAt: "2026-08-04T17:02:00.000Z",
        idempotencyKey: `ios-${suffix}-highlight`,
      },
    ];
  };
  const writeIcloud = (captures: PhoneCapture[], prefix: string) => {
    for (const capture of captures) {
      writeFileSync(
        join(inbox, `papertrail-${prefix}-${capture.kind}.json`),
        JSON.stringify(capture),
      );
    }
  };
  const worker = (captures: PhoneCapture[], ackBodies: string[][]) => {
    const rows: WorkerInboxRow[] = captures.map(({ kind, ...payload }) => ({
      id: `row-${payload.idempotencyKey}`,
      kind,
      receivedAt: payload.capturedAt,
      payload,
    }));
    return createWorkerInboxAdapter({
      fetchFn: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/drain") {
          return Response.json({ rows, nextCursor: null });
        }
        if (url.pathname === "/v1/ack") {
          const body = JSON.parse(String(init?.body)) as { ids: string[] };
          ackBodies.push(body.ids);
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    });
  };
  const itemIds = () => {
    const db = openDb(root);
    const ids = (db.query("SELECT id FROM items ORDER BY id").all() as Array<{ id: string }>)
      .map((row) => row.id);
    db.close();
    return ids;
  };
  const a = group("icloud-first");
  const b = group("worker-first");
  const c = group("same-pass");
  const acks: string[][] = [];
  writeIcloud(a, "first-a");
  const article = `<html><head><title>Convergence fixture</title></head><body><article><h1>Convergence fixture</h1><p>${
    "Substantive two-path capture text. ".repeat(30)
  }</p></article></body></html>`;
  const first = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [createIcloudInboxAdapter(), worker(b, acks)],
    fetchFn: async () =>
      new Response(article, { headers: { "content-type": "text/html" } }),
  });
  expect(first).toMatchObject({ pulled: 6, processed: 6, acked: 6, errors: 0 });
  const firstIds = itemIds();
  expect(firstIds).toHaveLength(4);

  writeIcloud(b, "delayed-b");
  expect(await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [worker(a, acks), createIcloudInboxAdapter()],
    fetchFn: async () => {
      throw new Error("replay must not refetch an immutable body");
    },
  })).toMatchObject({ pulled: 6, processed: 6, acked: 6, errors: 0 });
  expect(itemIds()).toEqual(firstIds);

  writeIcloud(c, "same-c");
  expect(await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [createIcloudInboxAdapter(), worker(c, acks)],
    fetchFn: async () =>
      new Response(article, { headers: { "content-type": "text/html" } }),
  })).toMatchObject({ pulled: 6, processed: 6, acked: 6, errors: 0 });
  const allIds = itemIds();
  expect(allIds).toHaveLength(6);

  writeIcloud(c, "replay-c");
  expect(await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [worker(c, acks), createIcloudInboxAdapter()],
    fetchFn: async () => {
      throw new Error("replay must not refetch an immutable body");
    },
  })).toMatchObject({ pulled: 6, processed: 6, acked: 6, errors: 0 });
  expect(itemIds()).toEqual(allIds);
  expect(acks).toEqual([
    b.map((capture) => `row-${capture.idempotencyKey}`),
    a.map((capture) => `row-${capture.idempotencyKey}`),
    c.map((capture) => `row-${capture.idempotencyKey}`),
    c.map((capture) => `row-${capture.idempotencyKey}`),
  ]);
  expect([...new Bun.Glob("inbox/raw/*.json").scanSync({ cwd: root })]).toEqual([]);
  expect([...new Bun.Glob("papertrail-*.json").scanSync({ cwd: inbox })]).toEqual([]);

  const db = openDb(root);
  const rows = db.query("SELECT url, md_path FROM items").all() as Array<{
    url: string | null;
    md_path: string;
  }>;
  for (const suffix of ["icloud-first", "worker-first", "same-pass"]) {
    const articleItem = readItem(
      root,
      rows.find((row) => row.url?.endsWith(suffix))!.md_path,
    );
    expect(articleItem.frontmatter.capture_contexts).toHaveLength(1);
    expect(articleItem.highlights).toEqual([
      expect.objectContaining({
        origin: "manual",
        text: `Exact selected passage ${suffix} arrives once.`,
      }),
    ]);
  }
  const noteItems = rows
    .filter((row) => row.url === null)
    .map((row) => readItem(root, row.md_path));
  expect(noteItems).toHaveLength(3);
  expect(noteItems.every((item) => item.frontmatter.capture_contexts.length === 1))
    .toBe(true);
  db.close();
});

test("restart after commit-before-ack interruption replays without loss or duplication", async () => {
  const { root, config, inbox } = makeRepo();
  const capturePath = join(inbox, "papertrail-002-save.json");
  writeFileSync(
    capturePath,
    JSON.stringify({
      kind: "save",
      url: "https://example.com/interrupted",
      title: "Interrupted drain",
      capturedAt: "2026-08-04T13:00:00.000Z",
    }),
  );
  const article = readFileSync(
    join(import.meta.dir, "fixtures", "extract", "article.html"),
    "utf8",
  );
  const underlying = createIcloudInboxAdapter();
  let interruptAck = true;
  const healthObservedBeforeAck: unknown[] = [];
  const adapter = {
    name: underlying.name,
    pull: underlying.pull.bind(underlying),
    ack: async (...args: Parameters<NonNullable<typeof underlying.ack>>) => {
      const healthDb = openDb(root);
      healthObservedBeforeAck.push(
        healthDb
          .query(
            "SELECT last_success_at, last_error FROM source_health WHERE source = 'icloud_inbox'",
          )
          .get(),
      );
      healthDb.close();
      if (interruptAck) throw new Error("simulated process interruption");
      return underlying.ack!(...args);
    },
  };

  const first = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [adapter],
    fetchFn: async () =>
      new Response(article, {
        headers: { "content-type": "text/html" },
      }),
  });
  expect(first).toMatchObject({ processed: 1, acked: 0, errors: 1 });
  expect(existsSync(capturePath)).toBe(true);
  expect([...new Bun.Glob("inbox/raw/*.json").scanSync({ cwd: root })]).toHaveLength(
    1,
  );
  expect(healthObservedBeforeAck[0]).toBeNull();
  let healthDb = openDb(root);
  expect(
    healthDb
      .query(
        "SELECT last_success_at, last_error FROM source_health WHERE source = 'icloud_inbox'",
      )
      .get(),
  ).toMatchObject({
    last_success_at: null,
    last_error: expect.stringContaining("acknowledgement failed"),
  });
  healthDb.close();

  interruptAck = false;
  const second = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [adapter],
    fetchFn: async () => {
      throw new Error("replay must not fetch an already stored body");
    },
  });
  expect(second).toMatchObject({ processed: 1, acked: 1, errors: 0 });
  expect(existsSync(capturePath)).toBe(false);
  expect([...new Bun.Glob("items/**/*.md").scanSync({ cwd: root })]).toHaveLength(
    1,
  );
  expect([...new Bun.Glob("inbox/raw/*.json").scanSync({ cwd: root })]).toEqual(
    [],
  );
  expect(git(root, "log", "--pretty=%s", "--grep=^daemon:")).toBe(
    "daemon: drain 1 capture",
  );
  expect(healthObservedBeforeAck[1]).toMatchObject({
    last_success_at: null,
    last_error: expect.stringContaining("acknowledgement failed"),
  });
  healthDb = openDb(root);
  expect(
    healthDb
      .query(
        "SELECT last_success_at, last_error FROM source_health WHERE source = 'icloud_inbox'",
      )
      .get(),
  ).toMatchObject({
    last_success_at: expect.any(String),
    last_error: null,
  });
  healthDb.close();
});

test("a Git write failure leaves the affected source unhealthy and unacknowledged", async () => {
  const { root, config } = makeRepo();
  writeFileSync(join(root, ".git", "index.lock"), "simulated competing Git writer\n");
  let acknowledged = false;
  const adapter: SourceAdapter = {
    name: "worker_inbox",
    pull: async () => [
      {
        kind: "note",
        source: "shortcut",
        text: "This capture must remain queued after commit rejection.",
        capturedAt: "2026-08-05T14:00:00.000Z",
        idempotencyKey: "commit-rejected-1",
      },
    ],
    ack: async () => {
      acknowledged = true;
    },
  };
  const unaffected: SourceAdapter = {
    name: "reading_list",
    pull: async () => [],
  };

  const result = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [adapter, unaffected],
  });

  expect(result).toMatchObject({ processed: 1, acked: 0, errors: 1 });
  expect(acknowledged).toBe(false);
  expect([...new Bun.Glob("inbox/raw/*.json").scanSync({ cwd: root })]).toHaveLength(
    1,
  );
  const db = openDb(root);
  expect(
    db
      .query(
        "SELECT last_success_at, last_error FROM source_health WHERE source = 'worker_inbox'",
      )
      .get(),
  ).toMatchObject({
    last_success_at: null,
    last_error: expect.stringContaining("git commit failed"),
  });
  expect(
    db
      .query(
        "SELECT last_success_at, last_error FROM source_health WHERE source = 'reading_list'",
      )
      .get(),
  ).toMatchObject({
    last_success_at: expect.any(String),
    last_error: null,
  });
  db.close();
});

test("a later daemon pass retries a transient fetch after its capture was acknowledged", async () => {
  const { root, config, inbox } = makeRepo();
  const capturePath = join(inbox, "papertrail-retry-save.json");
  writeFileSync(
    capturePath,
    JSON.stringify({
      kind: "save",
      url: "https://example.com/retry-me",
      capturedAt: "2026-08-04T13:30:00.000Z",
    }),
  );
  const adapter = createIcloudInboxAdapter();
  const first = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [adapter],
    fetchFn: async () => new Response("unavailable", { status: 503 }),
  });
  expect(first).toMatchObject({ acked: 1, errors: 0, retried: 0 });
  expect(existsSync(capturePath)).toBe(false);
  let db = openDb(root);
  expect(
    db.query("SELECT status, fetch_attempts FROM items").get(),
  ).toMatchObject({ status: "captured", fetch_attempts: 1 });
  db.close();

  const article = readFileSync(
    join(import.meta.dir, "fixtures", "extract", "article.html"),
    "utf8",
  );
  const second = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [adapter],
    fetchFn: async () =>
      new Response(article, { headers: { "content-type": "text/html" } }),
  });
  expect(second).toMatchObject({ pulled: 0, processed: 0, retried: 1, errors: 0 });
  db = openDb(root);
  const item = db.query("SELECT status, fetch_attempts, md_path FROM items").get() as {
    status: string;
    fetch_attempts: number;
    md_path: string;
  };
  expect(item.status).toBe("has_body");
  expect(item.fetch_attempts).toBe(1);
  expect(readItem(root, item.md_path).body.length).toBeGreaterThan(100);
  db.close();
});

test("newsletter tracking links resolve before the immutable body is stored", async () => {
  const { root, config } = makeRepo();
  const adapter: SourceAdapter = {
    name: "worker_inbox",
    pull: async () => [
      {
        kind: "email",
        source: "newsletter",
        emailFrom: "author@newsletter.example",
        emailSubject: "Canonical newsletter",
        capturedAt: "2026-08-04T14:00:00.000Z",
        html: `<html><head><link rel="canonical" href="https://newsletter.example/p/canonical"></head><body><p>${"Substantive newsletter text. ".repeat(8)}</p><a href="https://email.mg2.substack.com/c/tracked">useful source</a></body></html>`,
      },
    ],
  };
  const result = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [adapter],
    fetchFn: async (url) => {
      if (url === "https://source.example/article") {
        return new Response(null, { status: 200 });
      }
      expect(url).toBe("https://email.mg2.substack.com/c/tracked");
      return new Response(null, {
        status: 302,
        headers: { location: "https://source.example/article" },
      });
    },
  });
  expect(result).toMatchObject({ processed: 1, errors: 0 });
  const db = openDb(root);
  const row = db.query("SELECT url, md_path FROM items").get() as {
    url: string;
    md_path: string;
  };
  const file = readItem(root, row.md_path);
  expect(row.url).toBe("https://newsletter.example/p/canonical");
  expect(file.body).toContain("https://source.example/article");
  expect(file.body).not.toContain("email.mg2.substack.com");
  db.close();
});

test("a forwarded email link keeps its comment as context and fetches article body", async () => {
  const { root, config } = makeRepo();
  const adapter: SourceAdapter = {
    name: "worker_inbox",
    pull: async () => [
      {
        kind: "email",
        source: "newsletter",
        emailFrom: "reader@example.com",
        emailSubject: "Fwd: worth reading",
        capturedAt: "2026-08-04T16:00:00.000Z",
        text: "The durability section matters: https://example.com/forwarded",
        idempotencyKey: "email-forward-1",
      },
    ],
  };
  const article = readFileSync(
    join(import.meta.dir, "fixtures", "extract", "article.html"),
    "utf8",
  );
  const result = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [adapter],
    fetchFn: async () =>
      new Response(article, { headers: { "content-type": "text/html" } }),
  });
  expect(result).toMatchObject({ processed: 1, errors: 0 });

  const db = openDb(root);
  const row = db.query("SELECT url, status, md_path FROM items").get() as {
    url: string;
    status: string;
    md_path: string;
  };
  const file = readItem(root, row.md_path);
  expect(row.url).toBe("https://example.com/essays/craft-of-extraction");
  expect(
    db.query("SELECT url FROM item_url_aliases").all(),
  ).toContainEqual({ url: "https://example.com/forwarded" });
  expect(row.status).toBe("has_body");
  expect(file.body.length).toBeGreaterThan(100);
  expect(file.frontmatter.capture_contexts).toEqual([
    expect.objectContaining({
      kind: "shared_text",
      source: "newsletter",
      text: "The durability section matters: https://example.com/forwarded",
    }),
  ]);
  db.close();
});

test("a plain-text email becomes a searchable note without a fabricated body", async () => {
  const { root, config } = makeRepo();
  const adapter: SourceAdapter = {
    name: "worker_inbox",
    pull: async () => [
      {
        kind: "email",
        source: "newsletter",
        emailFrom: "reader@example.com",
        emailSubject: "A thought to keep",
        capturedAt: "2026-08-04T16:00:00.000Z",
        text: "Quorum visibility is different from queue durability.",
        idempotencyKey: "email-note-1",
      },
    ],
  };
  const result = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [adapter],
    fetchFn: async () => {
      throw new Error("a text note must not fetch");
    },
  });
  expect(result).toMatchObject({ processed: 1, errors: 0 });

  const db = openDb(root);
  const row = db.query("SELECT status, md_path FROM items").get() as {
    status: string;
    md_path: string;
  };
  const file = readItem(root, row.md_path);
  expect(row.status).toBe("stub");
  expect(file.body).toBe("");
  expect(file.highlights).toEqual([]);
  expect(file.frontmatter.capture_contexts[0]).toMatchObject({
    kind: "note",
    source: "newsletter",
    text: "Quorum visibility is different from queue durability.",
  });
  db.close();
});

test("a simulated Reading List permission denial emits an iMessage alert, not an empty success", async () => {
  const { root, config } = makeRepo();
  const permissionError = Object.assign(new Error("permission denied"), {
    code: "EACCES",
  });
  const adapter = createReadingListAdapter({
    copyFile: () => {
      throw permissionError;
    },
  });
  const result = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [adapter],
  });
  expect(result).toMatchObject({ pulled: 0, processed: 0, errors: 1 });
  const outbox = readFileSync(join(root, "logs", "outbox.log"), "utf8");
  expect(outbox).toContain("Wordhold alert:");
  expect(outbox).toContain("Full Disk Access");
  const db = openDb(root);
  const health = db
    .query("SELECT last_success_at, last_error FROM source_health WHERE source = 'reading_list'")
    .get() as { last_success_at: string | null; last_error: string };
  expect(health.last_success_at).toBeNull();
  expect(health.last_error).toContain("EACCES");
  db.close();
});

test("a missing configured source is degraded health, not empty success", async () => {
  const { root, config } = makeRepo();
  config.icloudInboxDir = join(root, "missing-icloud-folder");
  const result = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [createIcloudInboxAdapter()],
  });
  expect(result).toMatchObject({ pulled: 0, processed: 0, errors: 0 });
  const db = openDb(root);
  const health = db
    .query(
      "SELECT last_success_at, last_error FROM source_health WHERE source = 'icloud_inbox'",
    )
    .get() as { last_success_at: string | null; last_error: string };
  expect(health.last_success_at).toBeNull();
  expect(health.last_error).toContain("missing");
  db.close();
});

test("recurring URL-less newsletters keep distinct bodies while each delivery replay dedupes", async () => {
  const { root, config } = makeRepo();
  const captures = [
    {
      kind: "email" as const,
      source: "newsletter" as const,
      emailFrom: "digest@example.com",
      emailSubject: "Weekly Digest",
      text: `First issue. ${"alpha ".repeat(30)}`,
      capturedAt: "2026-08-01T12:00:00.000Z",
      idempotencyKey: "delivery-one",
    },
    {
      kind: "email" as const,
      source: "newsletter" as const,
      emailFrom: "digest@example.com",
      emailSubject: "Weekly Digest",
      text: `Second issue. ${"beta ".repeat(30)}`,
      capturedAt: "2026-08-08T12:00:00.000Z",
      idempotencyKey: "delivery-two",
    },
  ];
  const adapter: SourceAdapter = {
    name: "worker_inbox",
    pull: async () => captures,
  };
  await runDaemonOnce({ repoRoot: root, config, adapters: [adapter] });
  await runDaemonOnce({ repoRoot: root, config, adapters: [adapter] });

  const db = openDb(root);
  const rows = db
    .query("SELECT id, md_path FROM items ORDER BY captured_at")
    .all() as { id: string; md_path: string }[];
  expect(rows).toHaveLength(2);
  expect(readItem(root, rows[0]!.md_path).body).toContain("First issue");
  expect(readItem(root, rows[1]!.md_path).body).toContain("Second issue");
  db.close();
});

test("daemon refuses to absorb a pre-existing human item edit into its runtime commit", async () => {
  const { root, config, inbox } = makeRepo();
  const firstPath = join(inbox, "papertrail-human-001-save.json");
  writeFileSync(
    firstPath,
    JSON.stringify({
      kind: "save",
      url: "https://example.com/human-dirty",
      capturedAt: "2026-08-04T15:00:00.000Z",
    }),
  );
  const article = readFileSync(
    join(import.meta.dir, "fixtures", "extract", "article.html"),
    "utf8",
  );
  await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [createIcloudInboxAdapter()],
    fetchFn: async () => new Response(article, { headers: { "content-type": "text/html" } }),
  });
  const db = openDb(root);
  const item = db.query("SELECT md_path FROM items").get() as { md_path: string };
  db.close();
  const canonicalPath = join(root, item.md_path);
  writeFileSync(canonicalPath, readFileSync(canonicalPath, "utf8") + "\nReader's uncommitted note\n");
  const beforeCommit = git(root, "rev-parse", "HEAD");

  const highlightPath = join(inbox, "papertrail-human-002-highlight.json");
  writeFileSync(
    highlightPath,
    JSON.stringify({
      kind: "highlight",
      url: "https://example.com/human-dirty",
      text: "A new captured highlight",
      capturedAt: "2026-08-04T16:00:00.000Z",
    }),
  );
  const result = await runDaemonOnce({
    repoRoot: root,
    config,
    adapters: [createIcloudInboxAdapter()],
  });
  expect(result.errors).toBeGreaterThan(0);
  expect(result.acked).toBe(0);
  expect(existsSync(highlightPath)).toBe(true);
  expect(git(root, "rev-parse", "HEAD")).toBe(beforeCommit);
  expect(readFileSync(canonicalPath, "utf8")).toContain("Reader's uncommitted note");
});
