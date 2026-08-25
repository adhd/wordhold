import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../core/db.ts";
import { ingestCapture, recordFetchResult } from "../core/store.ts";
import { rehearseLocalRestore } from "../scripts/verify-local-restore.ts";

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

test("a fresh local snapshot restores canonical ids, body hashes, and search", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-restore-source-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Papertrail Test");
    git(root, "config", "user.email", "papertrail@example.invalid");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, ".gitignore"), "papertrail.db*\ninbox/\nlogs/*.log\n");
    const db = openDb(root);
    const captured = ingestCapture(root, db, {
      kind: "save",
      source: "shortcut",
      url: "https://example.com/restore-proof",
      title: "Restore Proof",
      capturedAt: "2026-08-05T10:00:00.000Z",
    });
    recordFetchResult(
      root,
      db,
      captured.item.id,
      { bodyMd: "Ferrochronology is the unique known restore query." },
      3,
    );
    db.close();
    git(root, "add", ".gitignore", captured.item.mdPath);
    git(root, "commit", "-qm", "seed coherent corpus snapshot");

    const proof = rehearseLocalRestore(root);
    expect(proof.itemCount).toBe(1);
    expect(proof.verifiedItemId).toBe(captured.item.id);
    expect(proof.queryMatchedExpectedItem).toBe(true);
    expect(proof.databaseAbsentBeforeRebuild).toBe(true);
    expect(proof.gitIntegrityOk).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
