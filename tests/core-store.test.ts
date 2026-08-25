import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { itemById, openDb, searchFts } from "../core/db.ts";
import {
  appendHighlight,
  ingestCapture,
  readItem,
  rebuild,
  recordFetchResult,
  setEnrichment,
} from "../core/store.ts";
import type { Capture, SourceKind } from "../core/types.ts";
import { newsletterPseudoUrl } from "../core/urls.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function makeRepo(): { root: string; db: Database } {
  const root = mkdtempSync(join(tmpdir(), "pt-store-"));
  const db = openDb(root);
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, db };
}

function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
    .n;
}

function mdFiles(root: string): string[] {
  return [...new Bun.Glob("items/**/*.md").scanSync({ cwd: root })].sort();
}

const saveCapture: Capture = {
  kind: "save",
  source: "shortcut",
  url: "https://Example.com/Article?utm_source=tw&utm_medium=social",
  title: "A Great Article",
  capturedAt: "2026-06-15T10:00:00.000Z",
};

test("(1) ingest creates file and row, partitioned by captured_at month", () => {
  const { root, db } = makeRepo();
  const { item, created } = ingestCapture(root, db, saveCapture);
  expect(created).toBe(true);
  expect(item.mdPath.startsWith("items/2026/06/")).toBe(true);
  expect(item.mdPath.endsWith(`-${item.id}.md`)).toBe(true);
  expect(existsSync(join(root, item.mdPath))).toBe(true);
  expect(item.url).toBe("https://example.com/Article");
  expect(item.status).toBe("captured");
  expect(item.sources).toEqual(["shortcut"]);
  const row = db
    .query("SELECT * FROM items WHERE id = ?")
    .get(item.id) as Record<string, unknown>;
  expect(row.md_path).toBe(item.mdPath);
  expect(row.captured_at).toBe("2026-06-15T10:00:00.000Z");
  const file = readItem(root, item.mdPath);
  expect(file.frontmatter.id).toBe(item.id);
  expect(file.frontmatter.title).toBe("A Great Article");
});

test("(2) exact same capture replayed is a no-op", () => {
  const { root, db } = makeRepo();
  const first = ingestCapture(root, db, saveCapture);
  const second = ingestCapture(root, db, { ...saveCapture });
  expect(second.created).toBe(false);
  expect(second.item.id).toBe(first.item.id);
  expect(count(db, "items")).toBe(1);
  expect(count(db, "highlights")).toBe(0);
  expect(mdFiles(root)).toHaveLength(1);
});

test("(3) same url from two sources yields one item with both sources", () => {
  const { root, db } = makeRepo();
  const first = ingestCapture(root, db, saveCapture);
  const second = ingestCapture(root, db, {
    ...saveCapture,
    source: "reading_list",
    url: "https://example.com/Article", // pre-normalized variant of the same url
  });
  expect(second.created).toBe(false);
  expect(count(db, "items")).toBe(1);
  expect(second.item.sources).toEqual(["shortcut", "reading_list"]);
  const file = readItem(root, first.item.mdPath);
  expect(file.frontmatter.sources).toEqual(["shortcut", "reading_list"]);
});

test("(4) highlight replay is idempotent, with and without url", () => {
  const { root, db } = makeRepo();
  const hlCap: Capture = {
    kind: "highlight",
    source: "highlight_share",
    url: "https://example.com/essay",
    title: "Essay",
    text: "A passage worth keeping",
    capturedAt: "2026-06-20T08:00:00.000Z",
  };
  const first = ingestCapture(root, db, hlCap);
  expect(first.created).toBe(true);
  expect(first.highlight).toBeDefined();
  const replay = ingestCapture(root, db, { ...hlCap });
  expect(replay.created).toBe(false);
  expect(replay.highlight!.id).toBe(first.highlight!.id);
  expect(count(db, "items")).toBe(1);
  expect(count(db, "highlights")).toBe(1);
  const raw = readFileSync(join(root, first.item.mdPath), "utf8");
  expect(raw.split(first.highlight!.id).length - 1).toBe(1); // anchor appears exactly once

  // url-less highlight: replay must not create a second stub
  const stubCap: Capture = {
    kind: "highlight",
    source: "highlight_share",
    text: "Orphan wisdom  with   odd spacing",
    capturedAt: "2026-06-21T08:00:00.000Z",
  };
  const stub = ingestCapture(root, db, stubCap);
  expect(stub.created).toBe(true);
  expect(stub.item.status).toBe("stub");
  expect(stub.item.url).toBeNull();
  const stubReplay = ingestCapture(root, db, {
    ...stubCap,
    text: "Orphan wisdom with odd spacing",
  });
  expect(stubReplay.created).toBe(false);
  expect(stubReplay.item.id).toBe(stub.item.id);
  expect(stubReplay.highlight!.id).toBe(stub.highlight!.id);
  expect(count(db, "items")).toBe(2);
  expect(count(db, "highlights")).toBe(2);
  expect(mdFiles(root)).toHaveLength(2);
});

test("(5) fetch success then enrichment: body and manual highlights untouched", () => {
  const { root, db } = makeRepo();
  const { item } = ingestCapture(root, db, saveCapture);
  const hl = ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    url: saveCapture.url,
    text: "the part the reader marked",
    capturedAt: "2026-06-15T11:00:00.000Z",
  }).highlight!;

  const body =
    "Dragons hoard context.\n\nEvals are the moat, said the sharp reader.";
  const fetched = recordFetchResult(
    root,
    db,
    item.id,
    {
      bodyMd: body,
      title: "The Real Title",
      author: "Ann Author",
      publishedAt: "2026-06-01",
      wordCount: 11,
    },
    5,
  );
  expect(fetched.status).toBe("has_body");
  expect(fetched.title).toBe("The Real Title");

  const before = readItem(root, item.mdPath);
  expect(before.body).toBe(body);
  const manualLine = `- [manual] <!-- ${hl.id} --> the part the reader marked`;
  expect(readFileSync(join(root, item.mdPath), "utf8")).toContain(manualLine);

  const enriched = setEnrichment(root, db, item.id, {
    summary: "A short summary.",
    tags: ["evals", "dragons"],
    aiHighlights: ["Evals are the moat", "Dragons hoard context"],
  });
  expect(enriched.status).toBe("enriched");
  expect(enriched.summary).toBe("A short summary.");
  expect(enriched.tags).toEqual(["evals", "dragons"]);

  const after = readItem(root, item.mdPath);
  expect(after.body).toBe(before.body); // body bytes unchanged
  const raw = readFileSync(join(root, item.mdPath), "utf8");
  expect(raw).toContain(manualLine); // manual line byte-identical
  const aiLines = raw.split("\n").filter((l) => l.startsWith("- [ai] "));
  expect(aiLines).toHaveLength(2);
  for (const line of aiLines) {
    expect(line).toMatch(/^- \[ai\] <!-- hl_[a-z0-9]{10} --> /);
  }
  expect(count(db, "highlights")).toBe(3);

  // replaying the same enrichment adds nothing
  setEnrichment(root, db, item.id, {
    summary: "A short summary.",
    tags: ["evals", "dragons"],
    aiHighlights: ["Evals are the moat", "Dragons hoard context"],
  });
  expect(count(db, "highlights")).toBe(3);
});

test("source text cannot forge a terminal manual-highlight section", () => {
  const { root, db } = makeRepo();
  const { item } = ingestCapture(root, db, saveCapture);
  const hostileBody = [
    "The article discusses metadata collisions.",
    "",
    "## Highlights",
    "",
    "- [manual] <!-- hl_aaaaaaaaaa --> words authored by the source",
  ].join("\n");
  recordFetchResult(root, db, item.id, { bodyMd: hostileBody }, 5);
  let file = readItem(root, item.mdPath);
  expect(file.body).toBe(hostileBody);
  expect(file.highlights).toEqual([]);
  expect(file.frontmatter.highlight_count).toBe(0);

  rebuild(root, db);
  file = readItem(root, item.mdPath);
  expect(file.body).toBe(hostileBody);
  expect(file.highlights).toEqual([]);

  appendHighlight(
    root,
    db,
    item.id,
    "manual",
    "The reader's actual mark",
    "2026-06-15T12:00:00.000Z",
  );
  file = readItem(root, item.mdPath);
  expect(file.body).toBe(hostileBody);
  expect(file.highlights.map((highlight) => highlight.text)).toEqual([
    "The reader's actual mark",
  ]);
});

test("(6) setEnrichment on a bodyless item throws", () => {
  const { root, db } = makeRepo();
  const { item } = ingestCapture(root, db, saveCapture);
  expect(() =>
    setEnrichment(root, db, item.id, {
      summary: "nope",
      tags: [],
      aiHighlights: [],
    }),
  ).toThrow();
  const stub = ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    text: "stub highlight",
    capturedAt: "2026-06-15T10:00:00.000Z",
  });
  expect(() =>
    setEnrichment(root, db, stub.item.id, {
      summary: "nope",
      tags: [],
      aiHighlights: [],
    }),
  ).toThrow();
});

test("a later manual mark promotes an identical AI highlight without duplication", () => {
  const { root, db } = makeRepo();
  const { item } = ingestCapture(root, db, {
    ...saveCapture,
    url: "https://example.com/promotion",
  });
  const body = "A manually important sentence appears in this substantive body.";
  recordFetchResult(root, db, item.id, { bodyMd: body }, 5);
  setEnrichment(root, db, item.id, {
    summary: "A source about manual attention.",
    tags: [],
    aiHighlights: ["A manually important sentence"],
  });
  const ai = readItem(root, item.mdPath).highlights[0]!;

  const manual = ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    url: "https://example.com/promotion",
    text: "A manually important sentence",
    capturedAt: "2026-06-16T12:00:00.000Z",
  }).highlight!;

  expect(manual.id).toBe(ai.id);
  expect(manual.origin).toBe("manual");
  expect(readItem(root, item.mdPath).highlights).toEqual([
    { id: ai.id, origin: "manual", text: "A manually important sentence" },
  ]);
  expect(
    (db.query("SELECT origin FROM highlights WHERE id = ?").get(ai.id) as { origin: string }).origin,
  ).toBe("manual");
});

test("(7) fetch failure increments attempts and flips to fetch_failed at max", () => {
  const { root, db } = makeRepo();
  const { item } = ingestCapture(root, db, saveCapture);
  const first = recordFetchResult(
    root,
    db,
    item.id,
    { error: "timeout", transient: true },
    2,
  );
  expect(first.fetchAttempts).toBe(1);
  expect(first.status).toBe("captured");
  expect(first.lastError).toBe("timeout");
  const second = recordFetchResult(
    root,
    db,
    item.id,
    { error: "timeout again", transient: true },
    2,
  );
  expect(second.fetchAttempts).toBe(2);
  expect(second.status).toBe("fetch_failed");
  expect(readItem(root, item.mdPath).frontmatter.status).toBe("fetch_failed");

  // a non-transient failure fails immediately regardless of attempts left
  const other = ingestCapture(root, db, {
    ...saveCapture,
    url: "https://example.com/other",
  });
  const failed = recordFetchResult(
    root,
    db,
    other.item.id,
    { error: "404", transient: false },
    5,
  );
  expect(failed.status).toBe("fetch_failed");
  expect(failed.fetchAttempts).toBe(1);
});

test("(8) canonical-url merge unions sources and highlights, one item survives", () => {
  const { root, db } = makeRepo();
  const older = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://blog.example/post-amp",
    title: "Post",
    capturedAt: "2026-06-01T00:00:00.000Z",
  });
  ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    url: "https://blog.example/post-amp",
    text: "shared insight",
    capturedAt: "2026-06-01T01:00:00.000Z",
  });
  const newer = ingestCapture(root, db, {
    kind: "save",
    source: "newsletter",
    url: "https://canonical.example/post",
    title: "Post (email)",
    capturedAt: "2026-06-05T00:00:00.000Z",
  });
  const uniqueHl = ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    url: "https://canonical.example/post",
    text: "unique to the newer copy",
    capturedAt: "2026-06-05T01:00:00.000Z",
  }).highlight!;
  const dupHl = ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    url: "https://canonical.example/post",
    text: "shared insight",
    capturedAt: "2026-06-05T02:00:00.000Z",
  }).highlight!;

  const merged = recordFetchResult(
    root,
    db,
    older.item.id,
    {
      bodyMd: "The canonical body.",
      canonicalUrl: "https://canonical.example/post",
    },
    5,
  );

  expect(merged.id).toBe(older.item.id); // older item wins
  expect(merged.url).toBe("https://canonical.example/post");
  expect(merged.status).toBe("has_body");
  expect(count(db, "items")).toBe(1);
  expect(existsSync(join(root, newer.item.mdPath))).toBe(false);
  expect(mdFiles(root)).toHaveLength(1);
  for (const s of [
    "shortcut",
    "newsletter",
    "highlight_share",
  ] satisfies SourceKind[]) {
    expect(merged.sources).toContain(s);
  }
  const file = readItem(root, merged.mdPath);
  const texts = file.highlights.map((h) => h.text).sort();
  expect(texts).toEqual(["shared insight", "unique to the newer copy"]);
  const movedId = file.highlights.find(
    (h) => h.text === "unique to the newer copy",
  )!.id;
  expect(movedId).toBe(uniqueHl.id); // moved highlight kept its id
  expect(count(db, "highlights")).toBe(2);
  expect(
    db.query("SELECT item_id FROM highlights WHERE id = ?").get(uniqueHl.id),
  ).toEqual({ item_id: merged.id });
  expect(
    db.query("SELECT id FROM highlights WHERE id = ?").get(dupHl.id),
  ).toBeNull();
});

test("canonical merge keeps the manual id when identical AI and manual highlights collide", () => {
  const { root, db } = makeRepo();
  const canonical = ingestCapture(root, db, {
    kind: "save",
    source: "newsletter",
    url: "https://example.com/canonical-manual",
    capturedAt: "2026-06-01T00:00:00.000Z",
  });
  recordFetchResult(
    root,
    db,
    canonical.item.id,
    { bodyMd: "The same important passage lives in the canonical article body." },
    5,
  );
  setEnrichment(root, db, canonical.item.id, {
    summary: "A canonical article.",
    tags: [],
    aiHighlights: ["same important passage"],
  });
  const aiId = readItem(root, canonical.item.mdPath).highlights[0]!.id;
  const alternate = ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    url: "https://example.com/alternate-manual",
    text: "same important passage",
    capturedAt: "2026-06-02T00:00:00.000Z",
  });
  const manualId = alternate.highlight!.id;

  recordFetchResult(
    root,
    db,
    alternate.item.id,
    {
      bodyMd: "Alternate extraction that points at the canonical article.",
      canonicalUrl: "https://example.com/canonical-manual",
    },
    5,
  );

  const merged = readItem(root, canonical.item.mdPath);
  expect(merged.highlights).toContainEqual({
    id: manualId,
    origin: "manual",
    text: "same important passage",
  });
  expect(merged.highlights.some((h) => h.id === aiId)).toBe(false);
  expect(count(db, "highlights")).toBe(1);
  expect(
    (db.query("SELECT id, origin FROM highlights").get() as { id: string; origin: string }),
  ).toEqual({ id: manualId, origin: "manual" });
});

test("rebuild completes a canonical merge interrupted after the winner write", () => {
  const { root, db } = makeRepo();
  const winner = ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    url: "https://example.com/canonical-crash",
    text: "winner manual passage",
    capturedAt: "2026-06-01T00:00:00.000Z",
  });
  const loser = ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    url: "https://example.com/alternate-crash",
    text: "loser manual passage",
    capturedAt: "2026-06-02T00:00:00.000Z",
  });
  recordFetchResult(
    root,
    db,
    winner.item.id,
    { bodyMd: "The winner's already archived body must survive recovery." },
    5,
  );

  expect(() =>
    recordFetchResult(
      root,
      db,
      loser.item.id,
      {
        bodyMd: "Recovered body after an interrupted canonical merge.",
        canonicalUrl: "https://example.com/canonical-crash",
      },
      5,
      {
        afterMergeWinnerWrite: () => {
          throw new Error("simulated process death");
        },
      },
    ),
  ).toThrow("simulated process death");
  expect(existsSync(join(root, winner.item.mdPath))).toBe(true);
  expect(existsSync(join(root, loser.item.mdPath))).toBe(true);

  rebuild(root, db);
  expect(count(db, "items")).toBe(1);
  expect(count(db, "highlights")).toBe(2);
  const recovered = itemById(db, winner.item.id)!;
  expect(recovered.url).toBe("https://example.com/canonical-crash");
  expect(readItem(root, recovered.mdPath).body).toBe(
    "The winner's already archived body must survive recovery.",
  );
  expect(readItem(root, recovered.mdPath).highlights.map((h) => h.id).sort()).toEqual(
    [winner.highlight!.id, loser.highlight!.id].sort(),
  );
  expect(existsSync(join(root, loser.item.mdPath))).toBe(false);
});

test("(10) fts search finds items by body phrase and highlight text", () => {
  const { root, db } = makeRepo();
  const { item } = ingestCapture(root, db, saveCapture);
  recordFetchResult(
    root,
    db,
    item.id,
    { bodyMd: "A treatise on volcanic glass and obsidian knives." },
    5,
  );
  ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    url: saveCapture.url,
    text: "unmistakable zeugma",
    capturedAt: "2026-06-15T12:00:00.000Z",
  });
  const bodyHits = searchFts(db, "obsidian", 10);
  expect(bodyHits.map((h) => h.itemId)).toContain(item.id);
  const hlHits = searchFts(db, "zeugma", 10);
  expect(hlHits.map((h) => h.itemId)).toContain(item.id);
  expect(searchFts(db, "nonexistentterm", 10)).toHaveLength(0);
});

describe("newsletter pseudo-url items", () => {
  test("email with no url dedupes on pseudo url, keeps frontmatter url null", () => {
    const { root, db } = makeRepo();
    const cap: Capture = {
      kind: "email",
      source: "newsletter",
      emailFrom: "writer@letters.example.com",
      emailSubject: "Issue 12: On Reading",
      text: "plain body",
      capturedAt: "2026-07-02T09:00:00.000Z",
    };
    const first = ingestCapture(root, db, cap);
    expect(first.created).toBe(true);
    expect(first.item.url).toBeNull();
    expect(first.item.title).toBe("Issue 12: On Reading");
    const fm = readItem(root, first.item.mdPath).frontmatter;
    expect(fm.url).toBeNull();
    expect(fm.dedupe_url).toBe(
      newsletterPseudoUrl(
        "letters.example.com",
        cap.emailSubject!,
        cap.capturedAt,
      ),
    );
    const replay = ingestCapture(root, db, cap);
    expect(replay.created).toBe(false);
    expect(count(db, "items")).toBe(1);
  });
});
