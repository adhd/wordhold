import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { ResurfacingEvent, ResurfacingState } from "./types.ts";
import { claimWriterPath } from "./writer.ts";
import { appendPrivateFile } from "./private-fs.ts";

// The journal is the source of truth for resurfacing state (AGENTS.md rule 7);
// the resurfacing_state table is derived from it.

function journalPath(repoRoot: string): string {
  return join(repoRoot, "logs", "resurfacing.jsonl");
}

export function appendResurfacingEvent(
  repoRoot: string,
  ev: ResurfacingEvent,
): void {
  claimWriterPath(repoRoot, "logs/resurfacing.jsonl");
  appendPrivateFile(journalPath(repoRoot), JSON.stringify(ev) + "\n");
}

export function foldJournal(repoRoot: string): Map<string, ResurfacingState> {
  const states = new Map<string, ResurfacingState>();
  const p = journalPath(repoRoot);
  if (!existsSync(p)) return states;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: ResurfacingEvent;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue; // a torn/corrupt line never blocks the fold
    }
    if (!ev.highlightId || !ev.action) continue;
    let st = states.get(ev.highlightId);
    if (!st) {
      st = {
        highlightId: ev.highlightId,
        lastShownAt: null,
        timesShown: 0,
        retired: false,
      };
      states.set(ev.highlightId, st);
    }
    if (ev.action === "shown") {
      st.timesShown += 1;
      st.lastShownAt = ev.at;
    } else if (ev.action === "retired") {
      st.retired = true;
    } else if (ev.action === "unretired") {
      st.retired = false;
    }
  }
  return states;
}

export function applyJournalToDb(repoRoot: string, db: Database): void {
  const states = foldJournal(repoRoot);
  const known = new Set(
    (db.query("SELECT id FROM highlights").all() as { id: string }[]).map(
      (r) => r.id,
    ),
  );
  const upsert = db.query(
    `INSERT INTO resurfacing_state (highlight_id, last_shown_at, times_shown, retired)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(highlight_id) DO UPDATE SET
       last_shown_at = excluded.last_shown_at,
       times_shown = excluded.times_shown,
       retired = excluded.retired`,
  );
  for (const st of states.values()) {
    if (!known.has(st.highlightId)) continue; // journal may reference merged-away highlights
    upsert.run(
      st.highlightId,
      st.lastShownAt,
      st.timesShown,
      st.retired ? 1 : 0,
    );
  }
}
