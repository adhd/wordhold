import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("D1 schema atomically retains only the newest 50 quarantined rows", () => {
  const db = new Database(":memory:");
  for (const migration of [
    "0001_init.sql",
    "0002_bound_quarantine.sql",
    "0003_capture_notes.sql",
  ]) {
    db.exec(
      readFileSync(join(import.meta.dir, "..", "worker", "migrations", migration), "utf8"),
    );
  }
  const insert = db.prepare(
    "INSERT INTO inbox (id, kind, payload, received_at, quarantined) VALUES (?, 'email', '{}', ?, 1)",
  );
  for (let index = 0; index < 100; index += 1) {
    insert.run(`in_${String(index).padStart(3, "0")}`, "2026-08-04T12:00:00.000Z");
  }
  const rows = db
    .query("SELECT id FROM inbox ORDER BY id")
    .all() as Array<{ id: string }>;
  expect(rows).toHaveLength(50);
  expect(rows[0]?.id).toBe("in_050");
  expect(rows.at(-1)?.id).toBe("in_099");
  db.run(
    "INSERT INTO inbox (id, kind, payload, received_at, quarantined) VALUES (?, 'note', ?, ?, 0)",
    ["in_note", '{"text":"kept as a note"}', "2026-08-04T12:01:00.000Z"],
  );
  expect(
    db.query("SELECT kind FROM inbox WHERE id = 'in_note'").get(),
  ).toEqual({ kind: "note" });
  db.close();
});
