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
import { openDb } from "../core/db.ts";
import { recordSourceRun } from "../core/health.ts";
import {
  appendHighlight,
  ingestCapture,
  recordFetchResult,
  setEnrichment,
} from "../core/store.ts";
import type { WordholdConfig } from "../core/types.ts";
import { runWeeklyDigest } from "../daemon/digest.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("weekly digest sends arrivals, highlights, patterns, failures, health, and new tags", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-digest-"));
  roots.push(root);
  const db = openDb(root);
  const config: WordholdConfig = {
    worker: { baseUrl: "", secret: "" },
    icloudInboxDir: "",
    readingListPlist: "",
    imessage: { recipient: "test", dryRun: true },
    enrichment: { minBodyChars: 20, maxFetchAttempts: 2 },
  };
  const first = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/retrieval",
    title: "Retrieval Notes",
    capturedAt: "2026-08-02T10:00:00.000Z",
  }).item;
  recordFetchResult(root, db, first.id, { bodyMd: "Context compounds when retrieval is reliable and deliberate." }, 2);
  appendHighlight(root, db, first.id, "manual", "Context compounds when retrieval is reliable", "2026-08-02T11:00:00.000Z");
  setEnrichment(root, db, first.id, {
    summary: "Reliable retrieval compounds context.",
    tags: ["memory systems"],
    aiHighlights: [],
  });
  const second = ingestCapture(root, db, {
    kind: "save",
    source: "newsletter",
    url: "https://example.com/memory",
    title: "Memory Notes",
    capturedAt: "2026-08-03T10:00:00.000Z",
  }).item;
  recordFetchResult(root, db, second.id, { bodyMd: "A second substantive note about memory systems and durable archives." }, 2);
  setEnrichment(root, db, second.id, {
    summary: "Archives make memory durable.",
    tags: ["memory systems"],
    aiHighlights: [],
  });
  const failed = ingestCapture(root, db, {
    kind: "save",
    source: "reading_list",
    url: "https://example.com/paywall",
    title: "The Paywalled Essay",
    capturedAt: "2026-08-03T12:00:00.000Z",
  }).item;
  recordFetchResult(root, db, failed.id, { error: "paywall_or_js_empty", transient: false }, 2);
  recordSourceRun(db, "icloud-inbox", { ok: true, newItems: 1 }, "2026-08-02T12:00:00.000Z");
  recordSourceRun(db, "worker_inbox", { ok: true, newItems: 0 }, "2026-08-01T12:00:00.000Z");
  recordSourceRun(db, "reading-list", { ok: false, newItems: 0, error: "EACCES" }, "2026-08-04T08:00:00.000Z");
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(
    join(root, "logs", "new-tags.jsonl"),
    JSON.stringify({ at: "2026-08-03T09:00:00.000Z", tag: "memory systems", definition: "How systems retain context." }) + "\n",
  );

  const result = await runWeeklyDigest({
    repoRoot: root,
    db,
    config,
    now: new Date("2026-08-04T12:00:00.000Z"),
  });

  expect(result.sent).toBe(false);
  expect(result.dryRun).toBe(true);
  const outbox = readFileSync(join(root, "logs", "outbox.log"), "utf8");
  expect(outbox).toContain("Your week in Wordhold: 3 items");
  expect(outbox).toContain("shortcut 1");
  expect(outbox).toContain("newsletter 1");
  expect(outbox).toContain("Context compounds when retrieval is reliable");
  expect(outbox).toContain("memory systems (2 items)");
  expect(outbox).toContain("The Paywalled Essay — paywall_or_js_empty");
  expect(outbox).toContain("reading-list: ERROR EACCES");
  expect(outbox).toContain("worker_inbox: STALE");
  expect(outbox).toContain("New tags: memory systems — How systems retain context.");
  expect(
    db.query("SELECT last_error FROM source_health WHERE source = 'job:digest'").get(),
  ).toEqual({ last_error: null });
  db.close();
});
