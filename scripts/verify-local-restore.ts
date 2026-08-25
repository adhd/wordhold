import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, searchFts } from "../core/db.ts";
import { readItem, rebuild } from "../core/store.ts";

export interface LocalRestoreProof {
  sourceCommit: string;
  restoredCommit: string;
  gitIntegrityOk: boolean;
  databaseAbsentBeforeRebuild: boolean;
  itemCount: number;
  verifiedItemId: string;
  bodyHashMatched: boolean;
  queryMatchedExpectedItem: boolean;
  elapsedMs: number;
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) {
    const reason = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`git ${args[0]} failed: ${reason}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function selectKnownItem(repoRoot: string): {
  id: string;
  mdPath: string;
  bodyHash: string;
  query: string;
} {
  const paths = git(repoRoot, ["ls-tree", "-r", "--name-only", "HEAD", "--", "items"])
    .split("\n")
    .filter((path) => path.endsWith(".md"));
  for (const mdPath of paths) {
    const item = readItem(repoRoot, mdPath);
    const query = item.body.match(/\b[A-Za-z][A-Za-z0-9]{7,}\b/)?.[0];
    if (!query) continue;
    return {
      id: item.frontmatter.id,
      mdPath,
      bodyHash: createHash("sha256").update(item.body).digest("hex"),
      query,
    };
  }
  throw new Error("restore rehearsal needs one committed canonical item with a searchable body");
}

// This proves same-Mac corpus/search mechanics from one completed Git commit.
// It deliberately does not contact adapters or claim off-machine durability.
export function rehearseLocalRestore(sourceRoot: string): LocalRestoreProof {
  const started = Date.now();
  const sourceCommit = git(sourceRoot, ["rev-parse", "HEAD"]);
  const scratch = mkdtempSync(join(tmpdir(), "papertrail-local-restore-"));
  const restoredRoot = join(scratch, "repo");
  try {
    git(scratch, [
      "clone",
      "--quiet",
      "--local",
      "--no-hardlinks",
      sourceRoot,
      restoredRoot,
    ]);
    const restoredCommit = git(restoredRoot, ["rev-parse", "HEAD"]);
    if (restoredCommit !== sourceCommit) {
      throw new Error("restore snapshot commit does not match source commit");
    }
    git(restoredRoot, ["fsck", "--full", "--strict"]);
    const databaseAbsentBeforeRebuild = !existsSync(
      join(restoredRoot, "papertrail.db"),
    );
    if (!databaseAbsentBeforeRebuild) {
      throw new Error("restore unexpectedly contained the derived database");
    }

    const expected = selectKnownItem(restoredRoot);
    // Re-read the raw canonical bytes before rebuilding so the proof compares
    // the derived row to the completed snapshot, not to an existing database.
    const canonicalBytes = readFileSync(join(restoredRoot, expected.mdPath));
    if (canonicalBytes.byteLength === 0) throw new Error("known canonical item is empty");

    const db = openDb(restoredRoot);
    try {
      rebuild(restoredRoot, db);
      const row = db
        .query("SELECT body_hash FROM items WHERE id = ?")
        .get(expected.id) as { body_hash: string | null } | null;
      const bodyHashMatched = row?.body_hash === expected.bodyHash;
      if (!bodyHashMatched) throw new Error("restored body hash does not match canonical snapshot");
      const queryMatchedExpectedItem = searchFts(db, expected.query, 20).some(
        (hit) => hit.itemId === expected.id,
      );
      if (!queryMatchedExpectedItem) {
        throw new Error("rebuilt search did not return the known canonical item");
      }
      const itemCount = (
        db.query("SELECT COUNT(*) AS count FROM items").get() as { count: number }
      ).count;
      return {
        sourceCommit,
        restoredCommit,
        gitIntegrityOk: true,
        databaseAbsentBeforeRebuild,
        itemCount,
        verifiedItemId: expected.id,
        bodyHashMatched,
        queryMatchedExpectedItem,
        elapsedMs: Date.now() - started,
      };
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const proof = rehearseLocalRestore(process.argv[2] ?? process.cwd());
  console.log(
    `local restore verified: commit ${proof.restoredCommit.slice(0, 12)}, ` +
      `${proof.itemCount} canonical items, hash and known-query checks passed, ` +
      `${proof.elapsedMs}ms`,
  );
  console.log("scope: same-Mac mechanics only; no off-machine durability was tested");
}
