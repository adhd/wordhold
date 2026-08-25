// One-pass orchestrator for the at-least-once capture sources. The
// durability order is raw spool -> canonical Markdown/derived DB -> scoped git
// commit -> adapter acknowledgement; changing that order changes the product's
// no-loss contract. See docs/architecture.md before editing this flow.
import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import { capabilityMode, loadConfig, resolveRepoRoot } from "../core/config.ts";
import { itemById, openDb } from "../core/db.ts";
import { commitPaths } from "../core/git.ts";
import { recordSourceRun } from "../core/health.ts";
import { log } from "../core/log.ts";
import {
  ingestCapture,
  rebuild,
  recordFetchResult,
} from "../core/store.ts";
import {
  AdapterHardError,
  type AdapterContext,
  type Capture,
  type Item,
  type WordholdConfig,
  type SourceAdapter,
} from "../core/types.ts";
import { createIcloudInboxAdapter } from "./adapters/icloud-inbox.ts";
import { createLocalCaptureAdapter } from "./adapters/local-capture.ts";
import { createReadingListAdapter } from "./adapters/reading-list.ts";
import { createWorkerInboxAdapter } from "./adapters/worker-inbox.ts";
import { emailCaptureToItemInput, resolveTrackingLinks } from "./email-item.ts";
import { fetchAndExtract, type FetchLike } from "./extract.ts";
import { sendAlert } from "./imessage.ts";
import { publicWebFetch } from "./public-fetch.ts";
import {
  persistRawCapture,
  removeRawCapture,
  scanRawCaptures,
  type RawCaptureEntry,
} from "./raw-spool.ts";
import {
  clearCurrentWriterIntent,
  currentWriterPaths,
  withWriterSession,
  WriterBusyError,
} from "../core/writer.ts";

export interface DaemonRunOptions {
  repoRoot: string;
  config: WordholdConfig;
  adapters?: SourceAdapter[];
  fetchFn?: FetchLike;
}

export interface DaemonRunResult {
  pulled: number;
  processed: number;
  retried: number;
  acked: number;
  errors: number;
}

const FETCH_RETRY_CAP = 10;

function defaultAdapters(config: WordholdConfig): SourceAdapter[] {
  const adapters: SourceAdapter[] = [createLocalCaptureAdapter()];
  if (capabilityMode(config, "workerInbox") === "enabled") {
    adapters.push(createWorkerInboxAdapter());
  }
  if (capabilityMode(config, "icloudInbox") === "enabled") {
    adapters.push(createIcloudInboxAdapter());
  }
  if (capabilityMode(config, "readingList") === "enabled") {
    adapters.push(createReadingListAdapter());
  }
  return adapters;
}

async function fetchCapturedItem(
  repoRoot: string,
  db: Database,
  config: WordholdConfig,
  item: Item,
  fetchFn?: FetchLike,
): Promise<boolean> {
  if (item.status !== "captured" || !item.url) return false;
  const extracted = await fetchAndExtract(item.url, {
    ...(fetchFn ? { fetchFn } : {}),
    minBodyChars: config.enrichment.minBodyChars,
  });
  recordFetchResult(
    repoRoot,
    db,
    item.id,
    extracted.ok
      ? {
          bodyMd: extracted.bodyMd,
          ...(extracted.title ? { title: extracted.title } : {}),
          ...(extracted.author ? { author: extracted.author } : {}),
          ...(extracted.publishedAt
            ? { publishedAt: extracted.publishedAt }
            : {}),
          ...(extracted.canonicalUrl
            ? { canonicalUrl: extracted.canonicalUrl }
            : {}),
        }
      : { error: extracted.reason, transient: extracted.transient },
    config.enrichment.maxFetchAttempts,
  );
  return true;
}

async function processCapture(
  repoRoot: string,
  db: Database,
  config: WordholdConfig,
  capture: Capture,
  fetchFn?: FetchLike,
): Promise<{ created: boolean }> {
  if (capture.kind === "email") {
    const email = emailCaptureToItemInput(capture);
    if (email.mode === "link_share" && email.url && email.contextText) {
      const stored = ingestCapture(repoRoot, db, {
        kind: "save",
        source: capture.source,
        url: email.url,
        title: email.title ?? undefined,
        text: email.contextText,
        capturedAt: capture.capturedAt,
        idempotencyKey: capture.idempotencyKey,
      });
      await fetchCapturedItem(repoRoot, db, config, stored.item, fetchFn);
      recordSourceRun(db, `email:${email.sender || "unknown"}`, {
        ok: true,
        newItems: stored.created ? 1 : 0,
      });
      return { created: stored.created };
    }
    if (
      email.mode === "plain_text" &&
      email.contextText &&
      email.bodyMd.trim().length < config.enrichment.minBodyChars
    ) {
      const stored = ingestCapture(repoRoot, db, {
        kind: "note",
        source: capture.source,
        title: email.title ?? undefined,
        text: email.contextText,
        capturedAt: capture.capturedAt,
        idempotencyKey: capture.idempotencyKey,
      });
      recordSourceRun(db, `email:${email.sender || "unknown"}`, {
        ok: true,
        newItems: stored.created ? 1 : 0,
      });
      return { created: stored.created };
    }
    const stored = ingestCapture(repoRoot, db, {
      ...capture,
      url: email.url ?? email.pseudoUrl ?? undefined,
      title: email.title ?? undefined,
    });
    if (email.bodyMd.trim()) {
      // Body text becomes immutable at the first canonical write, so resolve
      // known newsletter redirectors here—after raw spooling, before storage.
      const bodyMd = await resolveTrackingLinks(email.bodyMd, {
        fetchFn: async (url, init) =>
          (fetchFn ?? publicWebFetch)(url, init as RequestInit),
      });
      recordFetchResult(
        repoRoot,
        db,
        stored.item.id,
        {
          bodyMd,
          ...(email.title ? { title: email.title } : {}),
          ...(email.url ? { canonicalUrl: email.url } : {}),
        },
        config.enrichment.maxFetchAttempts,
      );
    } else {
      recordFetchResult(
        repoRoot,
        db,
        stored.item.id,
        { error: "email_body_empty", transient: false },
        config.enrichment.maxFetchAttempts,
      );
    }
    recordSourceRun(db, `email:${email.sender || "unknown"}`, {
      ok: true,
      newItems: stored.created ? 1 : 0,
    });
    return { created: stored.created };
  }

  const stored = ingestCapture(repoRoot, db, capture);
  await fetchCapturedItem(repoRoot, db, config, stored.item, fetchFn);
  return { created: stored.created };
}

async function runDaemonUnlocked(
  options: DaemonRunOptions,
): Promise<DaemonRunResult> {
  const adapters = options.adapters ?? defaultAdapters(options.config);
  const ctx: AdapterContext = {
    repoRoot: options.repoRoot,
    config: options.config,
  };
  const result: DaemonRunResult = {
    pulled: 0,
    processed: 0,
    retried: 0,
    acked: 0,
    errors: 0,
  };
  const db = openDb(options.repoRoot);
  const adapterRuns: Array<{
    adapter: SourceAdapter;
    entries: RawCaptureEntry[];
    completed: RawCaptureEntry[];
    created: number;
    pullFailed: boolean;
    pullNote?: string;
  }> = [];

  try {
    // SQLite is derived. Rebuilding once at process startup reconciles a crash
    // after canonical rename but before the corresponding DB transaction.
    try {
      rebuild(options.repoRoot, db);
    } catch (error) {
      result.errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      recordSourceRun(db, "job:daemon", {
        ok: false,
        newItems: 0,
        error: `canonical rebuild failed: ${message}`,
      });
      log(options.repoRoot, "daemon", `canonical rebuild failed: ${message}`);
      return result;
    }
    const rawScan = scanRawCaptures(options.repoRoot);
    const pending = rawScan.entries;
    if (rawScan.issues.length > 0) {
      result.errors += rawScan.issues.length;
      const sample = rawScan.issues
        .slice(0, 3)
        .map((issue) => `${basename(issue.path)}: ${issue.reason}`)
        .join("; ");
      const omitted = rawScan.issues.length - 3;
      recordSourceRun(db, "raw_spool", {
        ok: false,
        newItems: 0,
        error: `${rawScan.issues.length} malformed raw capture${rawScan.issues.length === 1 ? "" : "s"}: ${sample}${omitted > 0 ? `; ${omitted} more` : ""}`,
      });
    } else {
      recordSourceRun(db, "raw_spool", { ok: true, newItems: 0 });
    }

    // Upstream captures are acknowledged after their first durable attempt,
    // so transient extraction failures must be retried from canonical state.
    // The cap keeps a bad backlog from monopolizing a five-minute daemon run.
    const retryRows = db
      .query(
        `SELECT id FROM items
         WHERE status = 'captured' AND url IS NOT NULL AND fetch_attempts < ?
         ORDER BY captured_at ASC, id ASC LIMIT ?`,
      )
      .all(options.config.enrichment.maxFetchAttempts, FETCH_RETRY_CAP) as {
      id: string;
    }[];
    for (const row of retryRows) {
      const item = itemById(db, row.id);
      if (!item) continue;
      try {
        if (
          await fetchCapturedItem(
            options.repoRoot,
            db,
            options.config,
            item,
            options.fetchFn,
          )
        ) {
          result.retried += 1;
        }
      } catch (error) {
        result.errors += 1;
        log(
          options.repoRoot,
          "daemon",
          `retry ${item.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    for (const adapter of adapters) {
      const entries = new Map<string, RawCaptureEntry>();
      for (const entry of pending) {
        if (entry.adapterName === adapter.name) entries.set(entry.path, entry);
      }

      let pullFailed = false;
      let pullNote: string | undefined;
      try {
        const captures = await adapter.pull(ctx);
        pullNote = adapter.note;
        result.pulled += captures.length;
        for (const capture of captures) {
          const entry = persistRawCapture(
            options.repoRoot,
            adapter.name,
            capture,
          );
          entries.set(entry.path, entry);
        }
      } catch (error) {
        pullFailed = true;
        result.errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        recordSourceRun(db, adapter.name, {
          ok: false,
          newItems: 0,
          error: message,
        });
        log(options.repoRoot, adapter.name, `pull failed: ${message}`);
        if (error instanceof AdapterHardError) {
          await sendAlert(options.repoRoot, options.config, message);
        }
      }

      const completed: RawCaptureEntry[] = [];
      let created = 0;
      for (const entry of entries.values()) {
        try {
          const outcome = await processCapture(
            options.repoRoot,
            db,
            options.config,
            entry.capture,
            options.fetchFn,
          );
          if (outcome.created) created += 1;
          result.processed += 1;
          completed.push(entry);
        } catch (error) {
          result.errors += 1;
          log(
            options.repoRoot,
            adapter.name,
            `capture ${entry.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      adapterRuns.push({
        adapter,
        entries: [...entries.values()],
        completed,
        created,
        pullFailed,
        ...(pullNote ? { pullNote } : {}),
      });
    }

    const itemPaths = currentWriterPaths();
    try {
      await commitPaths(
        options.repoRoot,
        itemPaths,
        result.processed > 0
          ? `daemon: drain ${result.processed} ${result.processed === 1 ? "capture" : "captures"}${result.retried > 0 ? `; retry ${result.retried}` : ""}`
          : `daemon: retry ${result.retried} ${result.retried === 1 ? "fetch" : "fetches"}`,
      );
      clearCurrentWriterIntent();
    } catch (error) {
      result.errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      log(
        options.repoRoot,
        "daemon",
        `commit failed; leaving upstream unacked: ${message}`,
      );
      for (const run of adapterRuns) {
        if (run.pullFailed) continue;
        const capturesComplete = run.completed.length === run.entries.length;
        const commitAffected = run.completed.length > 0;
        recordSourceRun(db, run.adapter.name, {
          ok: !commitAffected && capturesComplete && !run.pullNote,
          newItems: run.created,
          error:
            commitAffected
              ? `git commit failed: ${message}`
              : !capturesComplete
                ? "one or more captures failed"
                : run.pullNote,
        });
      }
      recordSourceRun(db, "job:daemon", {
        ok: false,
        newItems: 0,
        error: `git commit failed: ${message}`,
      });
      return result;
    }

    for (const run of adapterRuns) {
      let ackError: string | null = null;
      if (run.completed.length > 0) {
        try {
          if (run.adapter.ack) {
            await run.adapter.ack(
              ctx,
              run.completed.map((entry) => entry.capture),
            );
          }
          for (const entry of run.completed) removeRawCapture(entry);
          result.acked += run.completed.length;
        } catch (error) {
          result.errors += 1;
          ackError = error instanceof Error ? error.message : String(error);
          log(
            options.repoRoot,
            run.adapter.name,
            `ack failed; raw spool retained: ${ackError}`,
          );
        }
      }
      if (run.pullFailed) continue;
      const capturesComplete = run.completed.length === run.entries.length;
      recordSourceRun(db, run.adapter.name, {
        ok: capturesComplete && !run.pullNote && ackError === null,
        newItems: run.created,
        ...(!capturesComplete
          ? { error: "one or more captures failed" }
          : run.pullNote
            ? { error: run.pullNote }
            : ackError
              ? { error: `acknowledgement failed: ${ackError}` }
              : {}),
      });
    }
    recordSourceRun(db, "job:daemon", {
      ok: result.errors === 0,
      newItems: 0,
      ...(result.errors > 0
        ? {
            error: `daemon pass completed with ${result.errors} error${result.errors === 1 ? "" : "s"}; see affected component health`,
          }
        : {}),
    });
    return result;
  } finally {
    db.close();
  }
}

export async function runDaemonOnce(
  options: DaemonRunOptions,
): Promise<DaemonRunResult> {
  try {
    return await withWriterSession(options.repoRoot, "daemon", () =>
      runDaemonUnlocked(options),
    );
  } catch (error) {
    if (!(error instanceof WriterBusyError)) throw error;
    log(options.repoRoot, "daemon", error.message);
    return { pulled: 0, processed: 0, retried: 0, acked: 0, errors: 1 };
  }
}

if (import.meta.main) {
  const repoRoot = resolveRepoRoot();
  const config = loadConfig(repoRoot);
  const result = await runDaemonOnce({ repoRoot, config });
  log(
    repoRoot,
    "daemon",
    `run done: ${result.pulled} pulled, ${result.processed} processed, ${result.retried} retried, ${result.acked} acked, ${result.errors} errors`,
  );
}
