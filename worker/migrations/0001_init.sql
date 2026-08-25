CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('save', 'highlight', 'email')),
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_inbox_received ON inbox(id);
CREATE INDEX IF NOT EXISTS idx_inbox_quarantine ON inbox(quarantined, id);

CREATE TABLE IF NOT EXISTS senders (
  address TEXT PRIMARY KEY,
  allowed_at TEXT NOT NULL
);
