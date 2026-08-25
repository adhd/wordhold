import { join } from "node:path";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { Database } from "bun:sqlite";
import schemaSql from "./schema.sql" with { type: "text" };
import type { Highlight, Item } from "./types.ts";
import { urlHash } from "./urls.ts";

// The db is a derived index (schema.sql header); markdown files win on conflict.

interface ItemRow {
  id: string;
  url: string | null;
  url_hash: string | null;
  title: string | null;
  author: string | null;
  status: Item["status"];
  fetch_attempts: number;
  last_error: string | null;
  sources: string;
  captured_at: string;
  published_at: string | null;
  word_count: number | null;
  summary: string | null;
  tags: string;
  md_path: string;
  body_hash: string | null;
}

export function openDb(repoRoot: string): Database {
  const dbPath = join(repoRoot, "papertrail.db");
  const paths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const existed = new Set(paths.filter((path) => existsSync(path)));
  if (!existed.has(dbPath)) closeSync(openSync(dbPath, "a", 0o600));
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  // Text import keeps the schema embedded in the compiled launchd binary;
  // import.meta.dir points inside Bun's virtual filesystem after compilation.
  db.exec(schemaSql);
  const ftsColumns = db
    .query("PRAGMA table_info(items_fts)")
    .all() as Array<{ name: string }>;
  if (!ftsColumns.some((column) => column.name === "contexts")) {
    // FTS is disposable, but preserve existing search rows until the daemon's
    // next canonical rebuild so a CLI open does not create a temporary outage.
    const rows = db
      .query("SELECT item_id, title, body, highlights FROM items_fts")
      .all() as Array<{
      item_id: string;
      title: string;
      body: string;
      highlights: string;
    }>;
    db.exec("DROP TABLE items_fts");
    db.exec(
      "CREATE VIRTUAL TABLE items_fts USING fts5(item_id UNINDEXED, title, body, highlights, contexts)",
    );
    const insert = db.prepare(
      "INSERT INTO items_fts (item_id, title, body, highlights, contexts) VALUES (?, ?, ?, ?, '')",
    );
    db.transaction(() => {
      for (const row of rows) {
        insert.run(row.item_id, row.title, row.body, row.highlights);
      }
    })();
  }
  for (const path of paths) {
    if (!existed.has(path) && existsSync(path)) chmodSync(path, 0o600);
  }
  return db;
}

/** Open the existing derived index without creating, migrating, or chmodding it. */
export function openReadOnlyDb(repoRoot: string): Database {
  const dbPath = join(repoRoot, "papertrail.db");
  if (!existsSync(dbPath)) {
    throw new Error("Wordhold index is missing; run `pt rebuild` before doctor");
  }
  return new Database(dbPath, { readonly: true, strict: true });
}

function rowToItem(r: ItemRow): Item {
  return {
    id: r.id,
    url: r.url,
    urlHash: r.url_hash,
    urlAliases: [],
    title: r.title,
    author: r.author,
    status: r.status,
    fetchAttempts: r.fetch_attempts,
    lastError: r.last_error,
    sources: JSON.parse(r.sources),
    capturedAt: r.captured_at,
    publishedAt: r.published_at,
    wordCount: r.word_count,
    summary: r.summary,
    tags: JSON.parse(r.tags),
    mdPath: r.md_path,
  };
}

export function upsertItemRow(
  db: Database,
  item: Item,
  bodyHash?: string | null,
): void {
  db.run(
    `INSERT INTO items (id, url, url_hash, title, author, status, fetch_attempts, last_error,
                        sources, captured_at, published_at, word_count, summary, tags, md_path, body_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       url = excluded.url,
       url_hash = excluded.url_hash,
       title = excluded.title,
       author = excluded.author,
       status = excluded.status,
       fetch_attempts = excluded.fetch_attempts,
       last_error = excluded.last_error,
       sources = excluded.sources,
       captured_at = excluded.captured_at,
       published_at = excluded.published_at,
       word_count = excluded.word_count,
       summary = excluded.summary,
       tags = excluded.tags,
       md_path = excluded.md_path,
       body_hash = COALESCE(excluded.body_hash, items.body_hash)`,
    [
      item.id,
      item.url,
      item.urlHash,
      item.title,
      item.author,
      item.status,
      item.fetchAttempts,
      item.lastError,
      JSON.stringify(item.sources),
      item.capturedAt,
      item.publishedAt,
      item.wordCount,
      item.summary,
      JSON.stringify(item.tags),
      item.mdPath,
      bodyHash ?? null,
    ],
  );
  db.run("DELETE FROM item_url_aliases WHERE item_id = ?", [item.id]);
  for (const alias of item.urlAliases) {
    db.run(
      `INSERT OR IGNORE INTO item_url_aliases (url_hash, item_id, url)
       VALUES (?, ?, ?)`,
      [urlHash(alias), item.id, alias],
    );
  }
}

export function insertHighlightRow(db: Database, hl: Highlight): boolean {
  const res = db.run(
    `INSERT INTO highlights (id, item_id, origin, text, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
    [hl.id, hl.itemId, hl.origin, hl.text, hl.dedupeKey, hl.createdAt],
  );
  return res.changes > 0;
}

export function syncItemFts(
  db: Database,
  item: Item,
  bodyText: string,
  highlightTexts: string[],
  contextTexts: string[] = [],
): void {
  db.run("DELETE FROM items_fts WHERE item_id = ?", [item.id]);
  db.run(
    "INSERT INTO items_fts (item_id, title, body, highlights, contexts) VALUES (?, ?, ?, ?, ?)",
    [
      item.id,
      item.title ?? "",
      bodyText,
      highlightTexts.join("\n"),
      contextTexts.join("\n"),
    ],
  );
}

export interface FtsHit {
  itemId: string;
  title: string | null;
  snippet: string;
}

export function searchFts(db: Database, query: string, limit = 20): FtsHit[] {
  const rows = db
    .query(
      `SELECT item_id, title,
              snippet(items_fts, 1, char(1), char(2), '…', 12) AS title_snip,
              snippet(items_fts, 2, char(1), char(2), '…', 12) AS body_snip,
              snippet(items_fts, 3, char(1), char(2), '…', 12) AS highlight_snip,
              snippet(items_fts, 4, char(1), char(2), '…', 12) AS context_snip
       FROM items_fts WHERE items_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(query, limit) as {
    item_id: string;
    title: string | null;
    title_snip: string;
    body_snip: string;
    highlight_snip: string;
    context_snip: string;
  }[];
  return rows.map((r) => {
    const candidates = [
      r.body_snip,
      r.highlight_snip,
      r.context_snip,
      r.title_snip,
    ];
    const marked = candidates.find((candidate) => candidate.includes("\u0001"));
    const snippet = (marked ?? candidates.find(Boolean) ?? "")
      .replaceAll("\u0001", "[")
      .replaceAll("\u0002", "]");
    return { itemId: r.item_id, title: r.title, snippet };
  });
}

export function itemById(db: Database, id: string): Item | null {
  const r = db
    .query("SELECT * FROM items WHERE id = ?")
    .get(id) as ItemRow | null;
  return r ? hydrateAliases(db, rowToItem(r)) : null;
}

export function itemByUrlHash(db: Database, urlHash: string): Item | null {
  const r = db
    .query(
      `SELECT i.* FROM items i
       LEFT JOIN item_url_aliases a ON a.item_id = i.id
       WHERE i.url_hash = ? OR a.url_hash = ?
       LIMIT 1`,
    )
    .get(urlHash, urlHash) as ItemRow | null;
  return r ? hydrateAliases(db, rowToItem(r)) : null;
}

export function itemByMdPath(db: Database, mdPath: string): Item | null {
  const r = db
    .query("SELECT * FROM items WHERE md_path = ?")
    .get(mdPath) as ItemRow | null;
  return r ? hydrateAliases(db, rowToItem(r)) : null;
}

function hydrateAliases(db: Database, item: Item): Item {
  item.urlAliases = (
    db
      .query("SELECT url FROM item_url_aliases WHERE item_id = ? ORDER BY url")
      .all(item.id) as { url: string }[]
  ).map((row) => row.url);
  return item;
}
