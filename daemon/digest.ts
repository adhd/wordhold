// Deterministic weekly summary. It reports what the corpus and health tables
// actually contain; it does not ask an agent to invent a narrative.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { loadConfig, resolveRepoRoot } from "../core/config.ts";
import { openDb } from "../core/db.ts";
import {
  healthState,
  recordSourceRun,
  sourceHealthReport,
} from "../core/health.ts";
import type { WordholdConfig, SourceKind } from "../core/types.ts";
import { sendIMessage, type SendResult } from "./imessage.ts";

const WEEK_MS = 7 * 86_400_000;
const DISPLAY_CAP = 5;

interface DigestItem {
  id: string;
  title: string | null;
  status: string;
  sources: string;
  tags: string;
  last_error: string | null;
}

export interface DigestOptions {
  repoRoot: string;
  db: Database;
  config: WordholdConfig;
  now?: Date;
  send?: typeof sendIMessage;
}

function recentTags(repoRoot: string, sinceIso: string): string[] {
  const path = join(repoRoot, "logs", "new-tags.jsonl");
  if (!existsSync(path)) return [];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      const entry = JSON.parse(raw) as { at?: unknown; tag?: unknown; definition?: unknown };
      if (
        typeof entry.at !== "string" ||
        entry.at < sinceIso ||
        typeof entry.tag !== "string" ||
        seen.has(entry.tag)
      ) continue;
      seen.add(entry.tag);
      lines.push(
        typeof entry.definition === "string"
          ? `${entry.tag} — ${entry.definition}`
          : entry.tag,
      );
    } catch {
      // A torn journal line should not suppress the rest of the digest.
    }
  }
  return lines;
}

export function buildWeeklyDigest(
  repoRoot: string,
  db: Database,
  now: Date = new Date(),
): string {
  const sinceIso = new Date(now.getTime() - WEEK_MS).toISOString();
  const items = db
    .query(
      `SELECT id, title, status, sources, tags, last_error
       FROM items WHERE captured_at >= ? ORDER BY captured_at DESC, id DESC`,
    )
    .all(sinceIso) as DigestItem[];

  const sourceCounts = new Map<SourceKind, number>();
  const tagCounts = new Map<string, number>();
  for (const item of items) {
    for (const source of JSON.parse(item.sources) as SourceKind[]) {
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    }
    for (const tag of new Set(JSON.parse(item.tags) as string[])) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const lines = [`Your week in Wordhold: ${items.length} item${items.length === 1 ? "" : "s"}`];
  lines.push(
    sourceCounts.size
      ? `Sources: ${[...sourceCounts.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([source, count]) => `${source} ${count}`)
          .join(", ")}`
      : "Sources: none",
  );

  const highlights = db
    .query(
      `SELECT h.origin, h.text, i.title
       FROM highlights h JOIN items i ON i.id = h.item_id
       WHERE i.captured_at >= ?
       ORDER BY CASE h.origin WHEN 'manual' THEN 0 ELSE 1 END,
                i.captured_at DESC, h.id
       LIMIT ?`,
    )
    .all(sinceIso, DISPLAY_CAP) as { origin: string; text: string; title: string | null }[];
  if (highlights.length) {
    lines.push("Highlights:");
    for (const h of highlights) lines.push(`- ${h.text} (${h.title ?? "untitled"}, ${h.origin})`);
  }

  const patterns = [...tagCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, DISPLAY_CAP);
  if (patterns.length) {
    lines.push(`Patterns: ${patterns.map(([tag, n]) => `${tag} (${n} items)`).join(", ")}`);
  }

  const failures = items
    .filter((item) => item.status === "captured" || item.status === "fetch_failed")
    .slice(0, DISPLAY_CAP);
  lines.push(`Failed/unfetched: ${items.filter((item) => item.status === "captured" || item.status === "fetch_failed").length}`);
  for (const item of failures) {
    lines.push(`- ${item.title ?? item.id} — ${item.last_error ?? item.status}`);
  }

  const health = sourceHealthReport(db, now.toISOString());
  lines.push("Health:");
  if (!health.length) lines.push("- no source runs recorded");
  for (const row of health) {
    const state = healthState(row);
    const status = state === "ERROR"
      ? `ERROR ${row.lastError}`
      : state === "STALE"
        ? `STALE, last run ${row.minutesSinceLastRun ?? "unknown"}m ago`
        : row.daysSinceLastNewItem === null
          ? "ok, no items yet"
          : `ok, ${row.daysSinceLastNewItem}d since new item`;
    lines.push(`- ${row.source}: ${status}`);
  }

  const tags = recentTags(repoRoot, sinceIso);
  lines.push(tags.length ? `New tags: ${tags.join("; ")}` : "New tags: none");
  return lines.join("\n");
}

export async function runWeeklyDigest(opts: DigestOptions): Promise<SendResult> {
  try {
    const result = await (opts.send ?? sendIMessage)(
      opts.repoRoot,
      opts.config,
      buildWeeklyDigest(opts.repoRoot, opts.db, opts.now),
    );
    recordSourceRun(opts.db, "job:digest", { ok: true, newItems: 0 });
    return result;
  } catch (error) {
    recordSourceRun(opts.db, "job:digest", {
      ok: false,
      newItems: 0,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

if (import.meta.main) {
  const repoRoot = resolveRepoRoot();
  const config = loadConfig(repoRoot);
  const db = openDb(repoRoot);
  try {
    await runWeeklyDigest({ repoRoot, db, config });
  } finally {
    db.close();
  }
}
