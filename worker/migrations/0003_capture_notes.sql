-- The unified capture route preserves plain text as an honest note instead of
-- misclassifying it as a manual highlight. Rebuild the small D1 queue table so
-- its kind constraint accepts that durable transport shape.
DROP TRIGGER IF EXISTS cap_quarantined_inbox;

CREATE TABLE inbox_with_notes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('save', 'highlight', 'note', 'email')),
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1))
);

INSERT INTO inbox_with_notes (id, kind, payload, received_at, quarantined)
SELECT id, kind, payload, received_at, quarantined FROM inbox;

DROP TABLE inbox;
ALTER TABLE inbox_with_notes RENAME TO inbox;

CREATE INDEX idx_inbox_received ON inbox(id);
CREATE INDEX idx_inbox_quarantine ON inbox(quarantined, id);

CREATE TRIGGER cap_quarantined_inbox
AFTER INSERT ON inbox
WHEN NEW.quarantined = 1
BEGIN
  DELETE FROM inbox
  WHERE quarantined = 1
    AND json_extract(payload, '$.bodyKey') IS NULL
    AND id NOT IN (
      SELECT id FROM inbox
      WHERE quarantined = 1
      ORDER BY id DESC
      LIMIT 50
    );
END;
