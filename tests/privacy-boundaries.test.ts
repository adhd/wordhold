import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../core/db.ts";
import { appendResurfacingEvent } from "../core/journal.ts";
import { log } from "../core/log.ts";
import { withWriterSession } from "../core/writer.ts";
import { sendIMessage } from "../daemon/imessage.ts";
import type { WordholdConfig } from "../core/types.ts";

function permissions(path: string): number {
  return statSync(path).mode & 0o777;
}

test("new local database and sidecars are owner-only", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-private-db-"));
  try {
    const db = openDb(root);
    db.run("INSERT INTO source_health (source, last_run_at) VALUES ('test', ?)", [
      new Date().toISOString(),
    ]);
    expect(permissions(join(root, "papertrail.db"))).toBe(0o600);
    expect(permissions(join(root, "papertrail.db-wal"))).toBe(0o600);
    expect(permissions(join(root, "papertrail.db-shm"))).toBe(0o600);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new runtime logs and authoritative journals are owner-only", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-private-logs-"));
  try {
    log(root, "test", "private message");
    appendResurfacingEvent(root, {
      highlightId: "hl_test",
      action: "shown",
      at: new Date().toISOString(),
    });
    const config = {
      imessage: { recipient: "test@example.invalid", dryRun: true },
    } as WordholdConfig;
    await sendIMessage(root, config, "private dry-run body");

    expect(permissions(join(root, "logs"))).toBe(0o700);
    for (const name of ["daemon.log", "resurfacing.jsonl", "outbox.log"]) {
      expect(permissions(join(root, "logs", name))).toBe(0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writer lock metadata is owner-only while a writer is active", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-private-writer-"));
  try {
    await withWriterSession(root, "daemon", async () => {
      const inbox = join(root, "inbox");
      const lock = join(inbox, "writer.lock");
      const owner = join(lock, "owner.json");
      expect(permissions(inbox)).toBe(0o700);
      expect(permissions(lock)).toBe(0o700);
      expect(permissions(owner)).toBe(0o600);
      expect(readFileSync(owner, "utf8")).toContain('"pid"');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
