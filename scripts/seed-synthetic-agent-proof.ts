// Creates a disposable, obviously synthetic corpus for real client acceptance.
// It refuses a root with existing canonical items and never contacts a network.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { initializeDataRoot } from "../core/installation.ts";
import { openDb } from "../core/db.ts";
import { commitPaths } from "../core/git.ts";
import {
  appendHighlight,
  ingestCapture,
  recordFetchResult,
} from "../core/store.ts";

const index = process.argv.indexOf("--data-root");
const dataRoot = index === -1 ? undefined : process.argv[index + 1];
if (!dataRoot) throw new Error("usage: seed-synthetic-agent-proof --data-root <new-root>");
if (
  existsSync(join(dataRoot, "items")) &&
  [...new Bun.Glob("items/**/*.md").scanSync({ cwd: dataRoot })].length > 0
) {
  throw new Error("refusing to seed a root that already contains canonical items");
}

initializeDataRoot(dataRoot);
const db = openDb(dataRoot);
try {
  const supporting = ingestCapture(dataRoot, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/synthetic-quorum-notes",
    title: "Synthetic quorum notes",
    text: "Synthetic context: compare quorum overlap with failure assumptions.",
    capturedAt: "2026-07-12T12:00:00.000Z",
  }).item;
  recordFetchResult(
    dataRoot,
    db,
    supporting.id,
    {
      bodyMd:
        "Synthetic consensus evidence: quorum overlap prevents two conflicting decisions when the stated failure bound holds.",
    },
    3,
  );
  appendHighlight(
    dataRoot,
    db,
    supporting.id,
    "manual",
    "quorum overlap prevents two conflicting decisions",
    "2026-07-12T12:01:00.000Z",
  );
  const unavailable = ingestCapture(dataRoot, db, {
    kind: "save",
    source: "reading_list",
    url: "https://example.com/synthetic-consensus-followup",
    title: "Synthetic consensus followup",
    capturedAt: "2026-07-20T12:00:00.000Z",
  }).item;
  recordFetchResult(
    dataRoot,
    db,
    unavailable.id,
    { error: "synthetic_unavailable: no body in fixture", transient: false },
    3,
  );
  await commitPaths(
    dataRoot,
    [supporting.mdPath, unavailable.mdPath],
    "seed synthetic agent verification",
  );
  console.log(
    JSON.stringify({
      status: "seeded",
      itemCount: 2,
      supportingId: supporting.id,
      unavailableId: unavailable.id,
    }),
  );
} finally {
  db.close();
}
