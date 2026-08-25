import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, searchFts } from "../core/db.ts";
import { ingestCapture, readItem, rebuild } from "../core/store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("shared text stays canonical, attributed, and searchable after rebuild", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-context-"));
  roots.push(root);
  let db = openDb(root);
  const result = ingestCapture(root, db, {
    kind: "save",
    source: "local_capture",
    url: "https://example.com/queueing",
    text: "The reader shared this because commit-before-ack is the key distinction.",
    capturedAt: "2026-08-04T16:00:00.000Z",
    idempotencyKey: "agent-request-1",
  });

  let file = readItem(root, result.item.mdPath);
  expect(file.body).toBe("");
  expect(file.highlights).toEqual([]);
  expect(file.frontmatter.capture_contexts).toEqual([
    {
      id: expect.stringMatching(/^cx_[a-z0-9]{10}$/),
      kind: "shared_text",
      source: "local_capture",
      text: "The reader shared this because commit-before-ack is the key distinction.",
      captured_at: "2026-08-04T16:00:00.000Z",
      identity_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  ]);
  expect(searchFts(db, "commit").map((hit) => hit.itemId)).toEqual([
    result.item.id,
  ]);

  db.close();
  db = openDb(root);
  rebuild(root, db);
  file = readItem(root, result.item.mdPath);
  expect(file.frontmatter.capture_contexts).toHaveLength(1);
  expect(searchFts(db, "distinction").map((hit) => hit.itemId)).toEqual([
    result.item.id,
  ]);
  db.close();
});

test("search snippets still surface manual-highlight matches", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-highlight-search-"));
  roots.push(root);
  const db = openDb(root);
  const result = ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    url: "https://example.com/highlight-search",
    text: "A deliberately marked quokka passage.",
    capturedAt: "2026-08-04T16:00:00.000Z",
  });

  expect(searchFts(db, "quokka")).toEqual([
    expect.objectContaining({
      itemId: result.item.id,
      snippet: expect.stringContaining("[quokka]"),
    }),
  ]);
  db.close();
});

test("replaying a text-only note does not mint another canonical stub", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-note-replay-"));
  roots.push(root);
  const db = openDb(root);
  const capture = {
    kind: "note" as const,
    source: "local_capture" as const,
    text: "This note should survive retries exactly once.",
    capturedAt: "2026-08-04T16:00:00.000Z",
    idempotencyKey: "note-1",
  };

  const first = ingestCapture(root, db, capture);
  const second = ingestCapture(root, db, {
    ...capture,
    capturedAt: "2026-08-04T17:00:00.000Z",
  });
  expect(second.created).toBe(false);
  expect(second.item.id).toBe(first.item.id);
  const distinct = ingestCapture(root, db, {
    ...capture,
    capturedAt: "2026-08-04T18:00:00.000Z",
    idempotencyKey: "note-2",
  });
  expect(distinct.created).toBe(true);
  expect(
    (db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n,
  ).toBe(2);
  expect(readItem(root, first.item.mdPath).frontmatter.capture_contexts).toHaveLength(1);
  db.close();
});
