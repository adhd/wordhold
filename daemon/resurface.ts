// Daily old-highlight resurfacing. Selection is deliberately deterministic:
// two manual-origin slots for every one AI slot, then oldest/least-shown first.
import type { Database } from "bun:sqlite";
import { loadConfig, resolveRepoRoot } from "../core/config.ts";
import { openDb } from "../core/db.ts";
import { changedPaths, commitPaths } from "../core/git.ts";
import { recordSourceRun } from "../core/health.ts";
import { appendResurfacingEvent, applyJournalToDb } from "../core/journal.ts";
import type { WordholdConfig } from "../core/types.ts";
import { sendIMessage, type SendResult } from "./imessage.ts";
import {
  clearCurrentWriterIntent,
  currentWriterPaths,
  recoverCurrentWriterIntent,
  withWriterSession,
} from "../core/writer.ts";

const OLD_AFTER_DAYS = 30;
const DAILY_COUNT = 3;
const MAX_SHOWS = 5;

interface Candidate {
  id: string;
  text: string;
  origin: "manual" | "ai";
  title: string | null;
}

export type SendFn = (
  repoRoot: string,
  config: WordholdConfig,
  text: string,
) => Promise<SendResult>;

export interface ResurfaceOptions {
  repoRoot: string;
  db: Database;
  config: WordholdConfig;
  now?: Date;
  send?: SendFn;
  // Production passes the required journal commit here so job health becomes
  // green only after the send, journal write, and git boundary all succeed.
  afterDelivery?: () => Promise<void>;
}

export type ResurfaceResult = SendResult & { highlightIds: string[] };

function candidates(
  db: Database,
  origin: "manual" | "ai",
  cutoffIso: string,
): Candidate[] {
  return db
    .query(
      `SELECT h.id, h.text, h.origin, i.title
       FROM highlights h
       JOIN items i ON i.id = h.item_id
       LEFT JOIN resurfacing_state s ON s.highlight_id = h.id
       WHERE h.origin = ? AND i.captured_at <= ?
         AND COALESCE(s.retired, 0) = 0
         AND COALESCE(s.times_shown, 0) < ?
       ORDER BY CASE WHEN s.last_shown_at IS NULL THEN 0 ELSE 1 END,
                s.last_shown_at ASC, h.created_at ASC, h.id ASC
       LIMIT 20`,
    )
    .all(origin, cutoffIso, MAX_SHOWS) as Candidate[];
}

function weightedSelection(manual: Candidate[], ai: Candidate[]): Candidate[] {
  const selected: Candidate[] = [];
  while (selected.length < DAILY_COUNT && (manual.length || ai.length)) {
    selected.push(...manual.splice(0, Math.min(2, DAILY_COUNT - selected.length)));
    if (selected.length < DAILY_COUNT && ai.length) selected.push(ai.shift()!);
    if (!manual.length && selected.length < DAILY_COUNT)
      selected.push(...ai.splice(0, DAILY_COUNT - selected.length));
    else if (!ai.length && selected.length < DAILY_COUNT)
      selected.push(...manual.splice(0, DAILY_COUNT - selected.length));
  }
  return selected;
}

export async function runDailyResurfacing(
  opts: ResurfaceOptions,
): Promise<ResurfaceResult> {
  try {
    // Fold from the configured repo, not the ambient process environment.
    applyJournalToDb(opts.repoRoot, opts.db);
    const now = opts.now ?? new Date();
    const cutoffIso = new Date(
      now.getTime() - OLD_AFTER_DAYS * 86_400_000,
    ).toISOString();
    const manual = candidates(opts.db, "manual", cutoffIso);
    const ai = candidates(opts.db, "ai", cutoffIso);
    const selected = weightedSelection(manual, ai);
    if (!selected.length) {
      recordSourceRun(opts.db, "job:resurface", { ok: true, newItems: 0 });
      return {
        sent: false,
        dryRun: opts.config.imessage.dryRun,
        highlightIds: [],
      };
    }
    const message = [
      "From your Wordhold archive:",
      ...selected.map(
        (h) => `- [${h.id}] ${h.text} — ${h.title ?? "untitled"} (${h.origin})`,
      ),
      "Reply `skip hl_…` to retire one.",
    ].join("\n");
    const delivery = await (opts.send ?? sendIMessage)(
      opts.repoRoot,
      opts.config,
      message,
    );
    if (delivery.sent) {
      for (const h of selected) {
        appendResurfacingEvent(opts.repoRoot, {
          at: now.toISOString(),
          highlightId: h.id,
          action: "shown",
        });
      }
      applyJournalToDb(opts.repoRoot, opts.db);
      await opts.afterDelivery?.();
    }
    recordSourceRun(opts.db, "job:resurface", { ok: true, newItems: 0 });
    return { ...delivery, highlightIds: selected.map((h) => h.id) };
  } catch (error) {
    recordSourceRun(opts.db, "job:resurface", {
      ok: false,
      newItems: 0,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function applyResurfacingReply(
  repoRoot: string,
  db: Database,
  reply: string,
  at: string = new Date().toISOString(),
): string[] {
  if (!/\b(skip|stop)\b/i.test(reply)) return [];
  applyJournalToDb(repoRoot, db);
  const ids = [...new Set(reply.match(/hl_[a-z0-9]{10}/g) ?? [])];
  const retired: string[] = [];
  for (const id of ids) {
    const row = db
      .query(
        `SELECT h.id, COALESCE(s.retired, 0) AS retired
         FROM highlights h LEFT JOIN resurfacing_state s ON s.highlight_id = h.id
         WHERE h.id = ?`,
      )
      .get(id) as { id: string; retired: number } | null;
    if (!row || row.retired) continue;
    appendResurfacingEvent(repoRoot, { at, highlightId: id, action: "retired" });
    retired.push(id);
  }
  if (retired.length) applyJournalToDb(repoRoot, db);
  return retired;
}

export async function commitResurfacing(repoRoot: string): Promise<boolean> {
  const claimed = currentWriterPaths();
  const paths = claimed.length
    ? claimed
    : await changedPaths(repoRoot, ["logs/resurfacing.jsonl"]);
  const committed = await commitPaths(
    repoRoot,
    paths,
    "resurface: update highlight journal",
  );
  if (claimed.length) clearCurrentWriterIntent();
  return committed;
}

if (import.meta.main) {
  const repoRoot = resolveRepoRoot();
  const config = loadConfig(repoRoot);
  const db = openDb(repoRoot);
  try {
    await withWriterSession(repoRoot, "resurface", async () => {
      await recoverCurrentWriterIntent("resurface: recover interrupted journal");
      const args = process.argv.slice(2);
      if (args[0] === "--reply") {
        const retired = applyResurfacingReply(
          repoRoot,
          db,
          args.slice(1).join(" "),
        );
        if (!retired.length)
          throw new Error("reply did not name a live highlight to retire");
        await commitResurfacing(repoRoot);
        console.log(`retired ${retired.join(", ")}`);
      } else {
        await runDailyResurfacing({
          repoRoot,
          db,
          config,
          afterDelivery: () => commitResurfacing(repoRoot).then(() => undefined),
        });
      }
    });
  } finally {
    db.close();
  }
}
