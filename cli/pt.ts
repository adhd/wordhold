// Small human/agent interface to the local corpus. Canonical markdown remains
// authoritative; this CLI only reads it or rebuilds the derived SQLite index.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoRoot } from "../core/config.ts";
import {
  normalizeCaptureRequest,
  type CaptureRequest,
} from "../core/capture-request.ts";
import { itemById, openDb, openReadOnlyDb, searchFts } from "../core/db.ts";
import { commitPaths } from "../core/git.ts";
import { rebuild } from "../core/store.ts";
import { archiveDoctor } from "../core/doctor.ts";
import {
  structuredItem,
  structuredHealth,
  structuredRecent,
  structuredSearch,
} from "../core/query.ts";
import {
  clearCurrentWriterIntent,
  currentWriterPaths,
  withWriterSession,
} from "../core/writer.ts";
import { persistRawCapture } from "../daemon/raw-spool.ts";

const USAGE = `Usage:
  pt capture <URL-or-text>
  pt capture --json
  pt recent [limit] | pt recent --json
  pt search <terms> | pt search --json
  pt show <item-id> | pt show --json
  pt health [--json]
  pt doctor [--json]
  pt rebuild`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function positiveLimit(raw: string | undefined, fallback = 20): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) fail("limit must be 1-200");
  return n;
}

export async function rebuildCorpus(
  repoRoot: string,
  db: ReturnType<typeof openDb>,
): Promise<void> {
  // A merge interrupted in the daemon already belongs to its durable writer
  // intent. Resume that owner so rebuild can finish both canonical files and
  // commit the exact recovered path set before clearing the intent.
  await withWriterSession(repoRoot, "daemon", async () => {
    rebuild(repoRoot, db);
    const paths = currentWriterPaths();
    if (paths.length > 0) {
      await commitPaths(repoRoot, paths, "maintenance: recover canonical writes");
    }
    clearCurrentWriterIntent();
  });
}

export async function main(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  const command = args[0];
  if (!command || !["capture", "recent", "search", "show", "health", "doctor", "rebuild"].includes(command)) {
    fail(command ? `unknown command: ${command}` : "command required");
  }
  const repoRoot = resolveRepoRoot();
  if (command === "capture") {
    let request: CaptureRequest;
    if (args[1] === "--json") {
      if (args.length !== 2) fail("--json does not accept positional input");
      try {
        const value: unknown = JSON.parse(await Bun.stdin.text());
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("capture request must be a JSON object");
        }
        request = value as CaptureRequest;
      } catch (error) {
        fail(error instanceof Error ? error.message : "invalid capture JSON");
      }
    } else {
      const input = args.slice(1).join(" ").trim();
      if (!input) fail("capture input required");
      request = { input };
    }
    let capture;
    try {
      capture = normalizeCaptureRequest(request, "local_capture");
    } catch (error) {
      fail(error instanceof Error ? error.message : "invalid capture request");
    }
    const queued = persistRawCapture(repoRoot, "local_capture", capture);
    console.log(
      JSON.stringify({
        status: "queued",
        queueId: queued.id,
        kind: capture.kind,
        ...(capture.url ? { url: capture.url } : {}),
      }),
    );
    return;
  }
  if (command === "doctor") {
    let request: unknown = {};
    if (args[1] === "--json") {
      if (args.length !== 2) fail("doctor --json accepts one JSON object on stdin");
      try {
        request = JSON.parse(await Bun.stdin.text());
      } catch (error) {
        fail(error instanceof Error ? error.message : "invalid doctor request");
      }
    } else if (args.length !== 1) {
      fail("doctor accepts only --json");
    }
    let doctorDb;
    try {
      doctorDb = openReadOnlyDb(repoRoot);
      const report = archiveDoctor(repoRoot, doctorDb, request);
      if (args[1] === "--json") {
        console.log(JSON.stringify(report));
      } else {
        console.log(
          `${report.summary.canonicalItems} items; ${report.summary.bodyAvailable} bodies; ${report.summary.enriched} enriched`,
        );
        for (const finding of report.findings) {
          console.log(`${finding.severity.toUpperCase()}\t${finding.code}\t${finding.count}`);
        }
      }
      if (!report.healthy) process.exitCode = 1;
    } catch (error) {
      fail(error instanceof Error ? error.message : "doctor failed");
    } finally {
      doctorDb?.close();
    }
    return;
  }
  const db = openDb(repoRoot);
  try {
    if (command === "recent") {
      if (args[1] === "--json") {
        if (args.length !== 2) fail("recent --json accepts one JSON object on stdin");
        try {
          const request: unknown = JSON.parse(await Bun.stdin.text());
          console.log(JSON.stringify(structuredRecent(db, request)));
        } catch (error) {
          fail(error instanceof Error ? error.message : "invalid structured recent request");
        }
        return;
      }
      const limit = positiveLimit(args[1]);
      const rows = db
        .query(
          `SELECT id, substr(captured_at, 1, 10) AS day, title, status
           FROM items ORDER BY captured_at DESC, id DESC LIMIT ?`,
        )
        .all(limit) as { id: string; day: string; title: string | null; status: string }[];
      for (const row of rows) {
        console.log(`${row.id}\t${row.day}\t${row.title ?? "(untitled)"}\t${row.status}`);
      }
      return;
    }
    if (command === "search") {
      if (args[1] === "--json") {
        if (args.length !== 2) fail("search --json accepts one JSON object on stdin");
        let request: unknown;
        try {
          request = JSON.parse(await Bun.stdin.text());
          console.log(JSON.stringify(structuredSearch(db, request)));
        } catch (error) {
          fail(error instanceof Error ? error.message : "invalid structured search request");
        }
        return;
      }
      const query = args.slice(1).join(" ").trim();
      if (!query) fail("search terms required");
      for (const hit of searchFts(db, query)) {
        console.log(`${hit.itemId}\t${hit.title ?? "(untitled)"}\t${hit.snippet}`);
      }
      return;
    }
    if (command === "show") {
      if (args[1] === "--json") {
        if (args.length !== 2) fail("show --json accepts one JSON object on stdin");
        try {
          const request: unknown = JSON.parse(await Bun.stdin.text());
          console.log(JSON.stringify(structuredItem(repoRoot, db, request)));
        } catch (error) {
          fail(error instanceof Error ? error.message : "invalid structured item request");
        }
        return;
      }
      const id = args[1];
      if (!id) fail("item id required");
      const item = itemById(db, id);
      if (!item) fail(`item not found: ${id}`);
      process.stdout.write(readFileSync(join(repoRoot, item.mdPath), "utf8"));
      return;
    }
    if (command === "health") {
      if (args[1] === "--json") {
        if (args.length !== 2) fail("health --json accepts one JSON object on stdin");
        try {
          const request: unknown = JSON.parse(await Bun.stdin.text());
          const report = structuredHealth(repoRoot, db, request);
          console.log(JSON.stringify(report));
          if (!report.healthy) process.exitCode = 1;
        } catch (error) {
          fail(error instanceof Error ? error.message : "invalid structured health request");
        }
        return;
      }
      const report = structuredHealth(repoRoot, db, {});
      for (const component of report.components) {
        const state = component.state === "healthy"
          ? "ok"
          : component.state === "never_run"
            ? "NEVER RUN"
            : component.state.toUpperCase();
        console.log(
          `${component.name}\t${state}\tlast run ${component.lastRunAt ?? "never"}\tlast success ${component.lastSuccessAt ?? "never"}${component.lastError ? `\t${component.lastError}` : ""}`,
        );
      }
      for (const retained of report.retainedWork) {
        console.log(
          `retained:${retained.component}\tSTALE\t${retained.count} retained; oldest ${retained.oldestPath} (${retained.oldestAgeMinutes}m)`,
        );
      }
      if (!report.healthy) process.exitCode = 1;
      return;
    }
    await rebuildCorpus(repoRoot, db);
    const count = (db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
    console.log(`rebuilt ${count} item${count === 1 ? "" : "s"}`);
  } finally {
    db.close();
  }
}

if (import.meta.main) await main();
