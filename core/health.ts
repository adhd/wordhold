import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Database } from "bun:sqlite";
import type { SourceHealth } from "./types.ts";

interface HealthRow {
  source: string;
  last_run_at: string | null;
  last_success_at: string | null;
  last_new_item_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
}

export interface SourceRunResult {
  ok: boolean;
  newItems: number;
  error?: string;
}

export function recordSourceRun(
  db: Database,
  source: string,
  run: SourceRunResult,
  nowIso: string = new Date().toISOString(),
): void {
  const prev = db
    .query("SELECT * FROM source_health WHERE source = ?")
    .get(source) as HealthRow | null;
  const lastSuccessAt = run.ok ? nowIso : (prev?.last_success_at ?? null);
  const lastNewItemAt =
    run.ok && run.newItems > 0 ? nowIso : (prev?.last_new_item_at ?? null);
  const consecutiveFailures = run.ok
    ? 0
    : (prev?.consecutive_failures ?? 0) + 1;
  const lastError = run.ok ? null : (run.error ?? "unknown error");
  db.run(
    `INSERT INTO source_health (source, last_run_at, last_success_at, last_new_item_at, last_error, consecutive_failures)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_success_at = excluded.last_success_at,
       last_new_item_at = excluded.last_new_item_at,
       last_error = excluded.last_error,
       consecutive_failures = excluded.consecutive_failures`,
    [
      source,
      nowIso,
      lastSuccessAt,
      lastNewItemAt,
      lastError,
      consecutiveFailures,
    ],
  );
}

export type SourceHealthReportRow = SourceHealth & {
  daysSinceLastNewItem: number | null;
  minutesSinceLastRun: number | null;
  minutesSinceLastSuccess: number | null;
};

export type HealthState = "ok" | "STALE" | "ERROR";

export const RETAINED_WORK_STALE_AFTER_MINUTES = 15;

export interface RetainedWorkHealth {
  component: "raw_spool" | "writer_intents";
  count: number;
  oldestPath: string;
  oldestAgeMinutes: number;
}

function staleFiles(
  repoRoot: string,
  component: RetainedWorkHealth["component"],
  relativeDir: string,
  nowMs: number,
): RetainedWorkHealth | null {
  const dir = join(repoRoot, relativeDir);
  if (!existsSync(dir)) return null;
  const stale = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(dir, name);
      try {
        const ageMinutes = Math.floor((nowMs - statSync(path).mtimeMs) / 60_000);
        return { path: relative(repoRoot, path), ageMinutes };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    })
    .filter((entry): entry is { path: string; ageMinutes: number } => entry !== null)
    .filter((entry) => entry.ageMinutes > RETAINED_WORK_STALE_AFTER_MINUTES)
    .sort((a, b) => b.ageMinutes - a.ageMinutes || a.path.localeCompare(b.path));
  if (stale.length === 0) return null;
  return {
    component,
    count: stale.length,
    oldestPath: stale[0]!.path,
    oldestAgeMinutes: stale[0]!.ageMinutes,
  };
}

export function retainedWorkHealth(
  repoRoot: string,
  nowMs: number = Date.now(),
): RetainedWorkHealth[] {
  return [
    staleFiles(repoRoot, "raw_spool", "inbox/raw", nowMs),
    staleFiles(repoRoot, "writer_intents", "inbox/writer-intents", nowMs),
  ].filter((entry): entry is RetainedWorkHealth => entry !== null);
}

export function staleAfterMinutes(source: string): number | null {
  if (
    ["worker_inbox", "icloud_inbox", "reading_list", "job:daemon"].includes(
      source,
    )
  ) {
    return 15;
  }
  if (source === "job:enrichment" || source === "job:resurface") return 26 * 60;
  if (source === "job:digest") return 8 * 24 * 60;
  return null;
}

export function healthState(row: SourceHealthReportRow): HealthState {
  if (row.lastError) return "ERROR";
  const threshold = staleAfterMinutes(row.source);
  if (
    threshold !== null &&
    (row.minutesSinceLastRun === null || row.minutesSinceLastRun > threshold)
  ) {
    return "STALE";
  }
  return "ok";
}

export function sourceHealthReport(
  db: Database,
  nowIso: string = new Date().toISOString(),
): SourceHealthReportRow[] {
  const rows = db
    .query("SELECT * FROM source_health ORDER BY source")
    .all() as HealthRow[];
  const now = Date.parse(nowIso);
  const minutesSince = (iso: string | null): number | null =>
    iso === null ? null : Math.floor((now - Date.parse(iso)) / 60_000);
  return rows.map((r) => ({
    source: r.source,
    lastRunAt: r.last_run_at,
    lastSuccessAt: r.last_success_at,
    lastNewItemAt: r.last_new_item_at,
    lastError: r.last_error,
    consecutiveFailures: r.consecutive_failures,
    minutesSinceLastRun: minutesSince(r.last_run_at),
    minutesSinceLastSuccess: minutesSince(r.last_success_at),
    daysSinceLastNewItem:
      r.last_new_item_at === null
        ? null
        : Math.floor((now - Date.parse(r.last_new_item_at)) / 86_400_000),
  }));
}
