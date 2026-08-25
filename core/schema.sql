-- SQLite index schema. The database is DERIVED state: fully rebuildable from
-- items/**.md plus logs/resurfacing.jsonl. Markdown wins on any disagreement.

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  url TEXT,
  url_hash TEXT UNIQUE,
  title TEXT,
  author TEXT,
  status TEXT NOT NULL CHECK (status IN ('stub','captured','fetch_failed','has_body','enriched')),
  fetch_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sources TEXT NOT NULL DEFAULT '[]',          -- JSON array of SourceKind
  captured_at TEXT NOT NULL,
  published_at TEXT,
  word_count INTEGER,
  summary TEXT,
  tags TEXT NOT NULL DEFAULT '[]',             -- JSON array
  md_path TEXT NOT NULL UNIQUE,
  body_hash TEXT                               -- sha256 of body, for cheap future embedding work
);

CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_captured_at ON items(captured_at);

CREATE TABLE IF NOT EXISTS item_url_aliases (
  url_hash TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  url TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_item_url_aliases_item ON item_url_aliases(item_id);

CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  origin TEXT NOT NULL CHECK (origin IN ('manual','ai')),
  text TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_health (
  source TEXT PRIMARY KEY,
  last_run_at TEXT,
  last_success_at TEXT,
  last_new_item_at TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

-- Derived from logs/resurfacing.jsonl (append-only journal); never authoritative.
CREATE TABLE IF NOT EXISTS resurfacing_state (
  highlight_id TEXT PRIMARY KEY REFERENCES highlights(id),
  last_shown_at TEXT,
  times_shown INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0
);

-- Full-text search over title, body, and highlight text.
-- Maintained by whoever writes items/highlights; rebuilt by `pt rebuild`.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  item_id UNINDEXED,
  title,
  body,
  highlights,
  contexts
);
