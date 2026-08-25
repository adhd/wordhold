import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../core/db.ts";
import { structuredRecent } from "../core/query.ts";
import { ingestCapture } from "../core/store.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("recent items page without gaps across equal timestamps", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-recent-pages-"));
  roots.push(root);
  const db = openDb(root);
  const ids = Array.from({ length: 5 }, (_, index) => ingestCapture(root, db, {
    kind: "save",
    source: "reading_list",
    url: `https://example.com/page-${index}`,
    title: `Page ${index}`,
    capturedAt: "2026-08-20T12:00:00.000Z",
  }).item.id);

  const first = structuredRecent(db, {
    from: "2026-08-01",
    sources: ["reading_list"],
    limit: 2,
  });
  expect(first.items).toHaveLength(2);
  expect(first.hasMore).toBe(true);
  expect(first.nextCursor).toEqual({
    capturedAt: first.items[1]!.capturedAt,
    id: first.items[1]!.id,
  });

  const second = structuredRecent(db, {
    from: "2026-08-01",
    sources: ["reading_list"],
    cursor: first.nextCursor!,
    limit: 2,
  });
  const third = structuredRecent(db, {
    from: "2026-08-01",
    sources: ["reading_list"],
    cursor: second.nextCursor!,
    limit: 2,
  });
  expect(second.hasMore).toBe(true);
  expect(third.hasMore).toBe(false);
  expect(third.nextCursor).toBeNull();
  expect([...first.items, ...second.items, ...third.items].map((item) => item.id).sort())
    .toEqual(ids.sort());
  db.close();
});

test("recent filters by source and lower boundary before paginating", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-recent-filter-"));
  roots.push(root);
  const db = openDb(root);
  const included = ingestCapture(root, db, {
    kind: "save",
    source: "reading_list",
    url: "https://example.com/included",
    title: "Included",
    capturedAt: "2026-08-20T12:00:00.000Z",
  }).item;
  ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/wrong-source",
    title: "Wrong source",
    capturedAt: "2026-08-21T12:00:00.000Z",
  });
  ingestCapture(root, db, {
    kind: "save",
    source: "reading_list",
    url: "https://example.com/too-old",
    title: "Too old",
    capturedAt: "2026-07-31T23:59:59.000Z",
  });

  const result = structuredRecent(db, {
    from: "2026-08-01",
    sources: ["reading_list"],
    limit: 10,
  });
  expect(result.items.map((item) => item.id)).toEqual([included.id]);
  expect(result.query).toEqual({
    from: "2026-08-01T00:00:00.000Z",
    sources: ["reading_list"],
    limit: 10,
  });
  db.close();
});

test("recent rejects malformed and ambiguous cursors", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-recent-invalid-"));
  roots.push(root);
  const db = openDb(root);
  expect(() => structuredRecent(db, {
    cursor: { capturedAt: "2026-08-20", id: "pt_1234567890" },
  })).toThrow("cursor.capturedAt must be an ISO date-time");
  expect(() => structuredRecent(db, {
    cursor: {
      capturedAt: "2026-08-20T12:00:00.000Z",
      id: "pt_1234567890",
      extra: true,
    },
  })).toThrow("recent cursor request contains unsupported field: extra");
  db.close();
});
