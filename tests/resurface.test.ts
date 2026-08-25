import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../core/db.ts";
import { foldJournal } from "../core/journal.ts";
import {
  appendHighlight,
  ingestCapture,
  recordFetchResult,
  setEnrichment,
} from "../core/store.ts";
import type { WordholdConfig } from "../core/types.ts";
import {
  applyResurfacingReply,
  runDailyResurfacing,
} from "../daemon/resurface.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("daily resurfacing favors manual highlights, journals delivery, and a reply retires one", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-resurface-"));
  roots.push(root);
  const db = openDb(root);
  const config: WordholdConfig = {
    worker: { baseUrl: "", secret: "" },
    icloudInboxDir: "",
    readingListPlist: "",
    imessage: { recipient: "test", dryRun: false },
    enrichment: { minBodyChars: 20, maxFetchAttempts: 2 },
  };
  const item = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/old",
    title: "Old Ideas",
    capturedAt: "2026-05-01T10:00:00.000Z",
  }).item;
  recordFetchResult(root, db, item.id, { bodyMd: "Old ideas remain useful when they return at the right moment." }, 2);
  const manualOne = appendHighlight(root, db, item.id, "manual", "Old ideas remain useful", "2026-05-01T11:00:00.000Z").highlight;
  const manualTwo = appendHighlight(root, db, item.id, "manual", "the right moment", "2026-05-01T11:01:00.000Z").highlight;
  setEnrichment(root, db, item.id, {
    summary: "Timing helps old ideas matter.",
    tags: [],
    aiHighlights: ["Old ideas remain useful when they return at the right moment."],
  });

  let delivered = "";
  const result = await runDailyResurfacing({
    repoRoot: root,
    db,
    config,
    now: new Date("2026-08-04T12:00:00.000Z"),
    send: async (_root, _config, message) => {
      delivered = message;
      return { sent: true, dryRun: false };
    },
  });

  expect(result.highlightIds).toHaveLength(3);
  expect(result.highlightIds.slice(0, 2)).toEqual([manualOne.id, manualTwo.id]);
  expect(delivered).toContain("Reply `skip hl_…` to retire one.");
  for (const id of result.highlightIds) expect(delivered).toContain(id);
  let state = foldJournal(root);
  for (const id of result.highlightIds) expect(state.get(id)?.timesShown).toBe(1);
  expect(
    db.query("SELECT last_error FROM source_health WHERE source = 'job:resurface'").get(),
  ).toEqual({ last_error: null });

  const retired = applyResurfacingReply(
    root,
    db,
    `stop this one ${manualOne.id}`,
    "2026-08-04T13:00:00.000Z",
  );
  expect(retired).toEqual([manualOne.id]);
  state = foldJournal(root);
  expect(state.get(manualOne.id)?.retired).toBe(true);

  delivered = "";
  const next = await runDailyResurfacing({
    repoRoot: root,
    db,
    config,
    now: new Date("2026-08-05T12:00:00.000Z"),
    send: async (_root, _config, message) => {
      delivered = message;
      return { sent: true, dryRun: false };
    },
  });
  expect(next.highlightIds).not.toContain(manualOne.id);
  expect(delivered).not.toContain(manualOne.id);
  expect(readFileSync(join(root, "logs", "resurfacing.jsonl"), "utf8")).toContain('"action":"retired"');
  db.close();
});

test("a dry run sends to the outbox but does not consume highlights", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-resurface-"));
  roots.push(root);
  const db = openDb(root);
  const config: WordholdConfig = {
    worker: { baseUrl: "", secret: "" },
    icloudInboxDir: "",
    readingListPlist: "",
    imessage: { recipient: "test", dryRun: true },
    enrichment: { minBodyChars: 20, maxFetchAttempts: 2 },
  };
  const item = ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    text: "A durable orphan highlight",
    capturedAt: "2026-05-01T10:00:00.000Z",
  });
  const result = await runDailyResurfacing({
    repoRoot: root,
    db,
    config,
    now: new Date("2026-08-04T12:00:00.000Z"),
  });
  expect(result.dryRun).toBe(true);
  expect(result.highlightIds).toEqual([item.highlight!.id]);
  expect(foldJournal(root).size).toBe(0);
  expect(readFileSync(join(root, "logs", "outbox.log"), "utf8")).toContain(item.highlight!.id);
  db.close();
});

test("a required journal commit failure records resurfacing as failed", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-resurface-"));
  roots.push(root);
  const db = openDb(root);
  const config: WordholdConfig = {
    worker: { baseUrl: "", secret: "" },
    icloudInboxDir: "",
    readingListPlist: "",
    imessage: { recipient: "test", dryRun: false },
    enrichment: { minBodyChars: 20, maxFetchAttempts: 2 },
  };
  const item = ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    text: "A durable old highlight",
    capturedAt: "2026-05-01T10:00:00.000Z",
  });
  const error = await runDailyResurfacing({
    repoRoot: root,
    db,
    config,
    now: new Date("2026-08-04T12:00:00.000Z"),
    send: async () => ({ sent: true, dryRun: false }),
    afterDelivery: async () => {
      throw new Error("simulated git failure");
    },
  }).catch((caught) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(item.highlight).toBeDefined();
  expect(
    db.query("SELECT last_error FROM source_health WHERE source = 'job:resurface'").get(),
  ).toEqual({ last_error: "simulated git failure" });
  db.close();
});
