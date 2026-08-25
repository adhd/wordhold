import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb, searchFts } from "../core/db.ts";
import { appendResurfacingEvent, foldJournal } from "../core/journal.ts";
import {
  ingestCapture,
  rebuild,
  recordFetchResult,
  setEnrichment,
} from "../core/store.ts";
import { recordSourceRun, sourceHealthReport } from "../core/health.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function snapshotItems(db: Database) {
  return db
    .query(
      "SELECT id, url, url_hash, title, status, sources, captured_at, summary, tags, md_path, word_count FROM items ORDER BY id",
    )
    .all();
}

function snapshotHighlights(db: Database) {
  return db
    .query(
      "SELECT id, item_id, origin, text, dedupe_key FROM highlights ORDER BY id",
    )
    .all();
}

test("(9) rebuild from files + journal reproduces the db with stable ids", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-rebuild-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let db = openDb(root);

  // enriched item with manual + ai highlights
  const a = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/deep-dive",
    title: "Deep Dive",
    capturedAt: "2026-05-10T10:00:00.000Z",
  });
  const manual = ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    url: "https://example.com/deep-dive",
    text: "the marked passage",
    capturedAt: "2026-05-10T11:00:00.000Z",
  }).highlight!;
  recordFetchResult(
    root,
    db,
    a.item.id,
    { bodyMd: "A long meditation on ferrous metallurgy and patience." },
    5,
  );
  setEnrichment(root, db, a.item.id, {
    summary: "Metallurgy, patiently.",
    tags: ["craft"],
    aiHighlights: ["ferrous metallurgy rewards patience"],
  });

  // url-less stub highlight
  const stub = ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    text: "an orphan aphorism",
    capturedAt: "2026-06-01T09:00:00.000Z",
  }).highlight!;

  // captured item that never got a body
  ingestCapture(root, db, {
    kind: "save",
    source: "reading_list",
    url: "https://example.com/unfetched",
    title: "Never Fetched",
    capturedAt: "2026-07-03T12:00:00.000Z",
  });

  // resurfacing journal
  appendResurfacingEvent(root, {
    at: "2026-07-10T08:00:00.000Z",
    highlightId: manual.id,
    action: "shown",
  });
  appendResurfacingEvent(root, {
    at: "2026-07-11T08:00:00.000Z",
    highlightId: manual.id,
    action: "shown",
  });
  appendResurfacingEvent(root, {
    at: "2026-07-11T09:00:00.000Z",
    highlightId: stub.id,
    action: "shown",
  });
  appendResurfacingEvent(root, {
    at: "2026-07-12T08:00:00.000Z",
    highlightId: stub.id,
    action: "retired",
  });
  // journal-driven state also lands in the live db the same way rebuild does it
  const itemsBefore = snapshotItems(db);
  const highlightsBefore = snapshotHighlights(db);
  expect(itemsBefore).toHaveLength(3);
  expect(highlightsBefore).toHaveLength(3);

  // delete the db entirely
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      unlinkSync(join(root, `papertrail.db${suffix}`));
    } catch {}
  }

  db = openDb(root);
  cleanups.push(() => db.close());
  rebuild(root, db);

  expect(snapshotItems(db)).toEqual(itemsBefore);
  expect(snapshotHighlights(db)).toEqual(highlightsBefore);

  // fts works after rebuild
  expect(searchFts(db, "metallurgy", 10).map((h) => h.itemId)).toContain(
    a.item.id,
  );
  expect(searchFts(db, "aphorism", 10)).toHaveLength(1);

  // resurfacing_state matches the folded journal
  const folded = foldJournal(root);
  const rows = db
    .query(
      "SELECT highlight_id, last_shown_at, times_shown, retired FROM resurfacing_state ORDER BY highlight_id",
    )
    .all() as {
    highlight_id: string;
    last_shown_at: string | null;
    times_shown: number;
    retired: number;
  }[];
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    const st = folded.get(row.highlight_id)!;
    expect(st).toBeDefined();
    expect(row.last_shown_at).toBe(st.lastShownAt);
    expect(row.times_shown).toBe(st.timesShown);
    expect(Boolean(row.retired)).toBe(st.retired);
  }
  const stubState = folded.get(stub.id)!;
  expect(stubState.retired).toBe(true);
  expect(stubState.timesShown).toBe(1);
  const manualState = folded.get(manual.id)!;
  expect(manualState.timesShown).toBe(2);
  expect(manualState.lastShownAt).toBe("2026-07-11T08:00:00.000Z");

  // rebuild is idempotent
  rebuild(root, db);
  expect(snapshotItems(db)).toEqual(itemsBefore);
  expect(snapshotHighlights(db)).toEqual(highlightsBefore);
});

test("source_health survives rebuild and reports staleness in days", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-health-"));
  const db = openDb(root);
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  recordSourceRun(
    db,
    "reading_list",
    { ok: true, newItems: 2 },
    "2026-07-01T00:00:00.000Z",
  );
  recordSourceRun(
    db,
    "reading_list",
    { ok: true, newItems: 0 },
    "2026-07-20T00:00:00.000Z",
  );
  recordSourceRun(
    db,
    "shortcut",
    { ok: false, newItems: 0, error: "worker unreachable" },
    "2026-07-20T00:00:00.000Z",
  );
  recordSourceRun(
    db,
    "shortcut",
    { ok: false, newItems: 0, error: "worker unreachable" },
    "2026-07-21T00:00:00.000Z",
  );

  rebuild(root, db); // wipes derived tables, not source_health

  const report = sourceHealthReport(db, "2026-07-31T00:00:00.000Z");
  expect(report).toHaveLength(2);
  const rl = report.find((r) => r.source === "reading_list")!;
  expect(rl.daysSinceLastNewItem).toBe(30);
  expect(rl.consecutiveFailures).toBe(0);
  expect(rl.lastError).toBeNull();
  expect(rl.minutesSinceLastRun).toBe(15_840);
  expect(rl.minutesSinceLastSuccess).toBe(15_840);
  const sc = report.find((r) => r.source === "shortcut")!;
  expect(sc.daysSinceLastNewItem).toBeNull();
  expect(sc.consecutiveFailures).toBe(2);
  expect(sc.lastError).toBe("worker unreachable");
});

test("a malformed canonical file leaves the last good search index intact", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-rebuild-corrupt-"));
  const db = openDb(root);
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const stored = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/last-good-index",
    title: "Last Good Index",
    capturedAt: "2026-08-05T12:00:00.000Z",
  });
  recordFetchResult(
    root,
    db,
    stored.item.id,
    { bodyMd: "The preserved search phrase is ferric continuity." },
    5,
  );
  const beforeItems = snapshotItems(db);
  const canonicalPath = join(root, stored.item.mdPath);
  const validCanonical = readFileSync(canonicalPath, "utf8");
  const concurrentReader = openDb(root);
  cleanups.push(() => concurrentReader.close());

  writeFileSync(
    canonicalPath,
    "---\nid: pt_corrupt\nhighlight_count: 1\n---\nMalformed canonical body\n",
  );

  expect(() => rebuild(root, db)).toThrow(
    "canonical highlight section missing",
  );
  expect(snapshotItems(db)).toEqual(beforeItems);
  expect(searchFts(db, "ferric", 10).map((hit) => hit.itemId)).toEqual([
    stored.item.id,
  ]);
  expect(
    searchFts(concurrentReader, "ferric", 10).map((hit) => hit.itemId),
  ).toEqual([stored.item.id]);

  writeFileSync(canonicalPath, validCanonical);
  rebuild(root, db);
  expect(snapshotItems(db)).toEqual(beforeItems);
  expect(searchFts(db, "ferric", 10).map((hit) => hit.itemId)).toEqual([
    stored.item.id,
  ]);
});
