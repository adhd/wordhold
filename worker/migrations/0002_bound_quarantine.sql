-- Keep unknown-sender quarantine in one transactional store. Accepted email
-- bodies continue to use R2 write-ahead; quarantined bodies never use R2.
CREATE TRIGGER IF NOT EXISTS cap_quarantined_inbox
AFTER INSERT ON inbox
WHEN NEW.quarantined = 1
BEGIN
  DELETE FROM inbox
  WHERE quarantined = 1
    -- Legacy deployments stored quarantine bodies in R2. Recovery converts
    -- those rows to metadata and tombstones their objects before they may be
    -- evicted; never orphan a live body from inside a D1 trigger.
    AND json_extract(payload, '$.bodyKey') IS NULL
    AND id NOT IN (
      SELECT id FROM inbox
      WHERE quarantined = 1
      ORDER BY id DESC
      LIMIT 50
    );
END;
