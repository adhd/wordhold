import type { Database } from "bun:sqlite";
import { readItem } from "./store.ts";

export interface DoctorFinding {
  code: string;
  severity: "warning" | "error";
  count: number;
  itemIds: string[];
}

export interface DoctorReport {
  version: 1;
  operation: "doctor";
  healthy: boolean;
  summary: {
    canonicalItems: number;
    indexedItems: number;
    bodyAvailable: number;
    bodyUnavailable: number;
    enriched: number;
    manualHighlights: number;
    aiHighlights: number;
    contexts: number;
  };
  findings: DoctorFinding[];
}

function requestObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("doctor request must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function terminalReason(lastError: string | null): string | null {
  if (!lastError) return null;
  // Report only a bounded machine reason, never provider text, URLs, or corpus
  // content that may follow it.
  const match = /^([a-z][a-z0-9_-]{1,63}):/.exec(lastError.trim());
  return match?.[1] ?? null;
}

function urlKind(url: string | null): "pdf" | "x" | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (/\.pdf$/i.test(parsed.pathname)) return "pdf";
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "x.com" || host === "twitter.com") return "x";
  } catch {
    // Canonical URL validation owns malformed-url reporting elsewhere.
  }
  return null;
}

function addFinding(
  buckets: Map<string, { severity: "warning" | "error"; ids: Set<string> }>,
  code: string,
  severity: "warning" | "error",
  id: string,
): void {
  const bucket = buckets.get(code) ?? { severity, ids: new Set<string>() };
  bucket.ids.add(id);
  buckets.set(code, bucket);
}

/**
 * Inspect archive coverage and derived-index agreement without repairing,
 * fetching, or returning article text. Canonical markdown remains the source
 * of truth; callers can decide what follow-up work is worth doing.
 */
export function archiveDoctor(
  repoRoot: string,
  db: Database,
  rawRequest: unknown,
): DoctorReport {
  const input = requestObject(rawRequest);
  const unknown = Object.keys(input).filter((key) => key !== "minBodyChars");
  if (unknown.length) {
    throw new Error(`doctor request contains unsupported field: ${unknown.sort().join(", ")}`);
  }
  const minBodyChars = input.minBodyChars === undefined
    ? 600
    : Number(input.minBodyChars);
  if (!Number.isInteger(minBodyChars) || minBodyChars < 1 || minBodyChars > 100_000) {
    throw new Error("minBodyChars must be an integer from 1 to 100000");
  }

  const paths = [...new Bun.Glob("items/**/*.md").scanSync({ cwd: repoRoot })].sort();
  const indexed = db.query("SELECT id, md_path FROM items").all() as Array<{
    id: string;
    md_path: string;
  }>;
  const indexedByPath = new Map(indexed.map((row) => [row.md_path, row.id]));
  const canonicalIds = new Set<string>();
  const buckets = new Map<
    string,
    { severity: "warning" | "error"; ids: Set<string> }
  >();
  let bodyAvailable = 0;
  let bodyUnavailable = 0;
  let enriched = 0;
  let manualHighlights = 0;
  let aiHighlights = 0;
  let contexts = 0;

  for (const path of paths) {
    let canonical;
    try {
      canonical = readItem(repoRoot, path);
    } catch {
      addFinding(buckets, "canonical_parse_error", "error", indexedByPath.get(path) ?? path);
      continue;
    }
    const front = canonical.frontmatter;
    canonicalIds.add(front.id);
    contexts += front.capture_contexts.length;
    manualHighlights += canonical.highlights.filter((h) => h.origin === "manual").length;
    aiHighlights += canonical.highlights.filter((h) => h.origin === "ai").length;
    if (front.status === "enriched") enriched += 1;

    if (canonical.body.length > 0) {
      bodyAvailable += 1;
      if (canonical.body.length < minBodyChars) {
        addFinding(buckets, "thin_body", "warning", front.id);
      }
      if (front.status === "has_body") {
        addFinding(buckets, "pending_enrichment", "warning", front.id);
      }
    } else {
      bodyUnavailable += 1;
      addFinding(buckets, "body_unavailable", "warning", front.id);
      const kind = urlKind(front.url);
      if (kind) {
        addFinding(buckets, `${kind}_url_body_unavailable`, "warning", front.id);
      }
    }
    if (canonical.body.length > 0 && front.status === "fetch_failed") {
      addFinding(buckets, "body_available_terminal_status", "warning", front.id);
    }
    if (front.status === "fetch_failed") {
      const reason = terminalReason(front.last_error);
      if (reason) addFinding(buckets, `terminal_failure:${reason}`, "warning", front.id);
    }
    if (indexedByPath.get(path) !== front.id) {
      addFinding(buckets, "index_mismatch", "error", front.id);
    }
  }

  for (const row of indexed) {
    if (!canonicalIds.has(row.id)) {
      addFinding(buckets, "index_orphan", "error", row.id);
    }
  }

  const ftsRows = (db.query("SELECT COUNT(*) AS count FROM items_fts").get() as {
    count: number;
  }).count;
  if (ftsRows !== indexed.length) {
    addFinding(buckets, "fts_count_mismatch", "error", "derived-index");
  }

  const findings = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, bucket]) => ({
      code,
      severity: bucket.severity,
      count: bucket.ids.size,
      itemIds: [...bucket.ids].sort().slice(0, 100),
    }));

  return {
    version: 1,
    operation: "doctor",
    healthy: findings.length === 0,
    summary: {
      canonicalItems: paths.length,
      indexedItems: indexed.length,
      bodyAvailable,
      bodyUnavailable,
      enriched,
      manualHighlights,
      aiHighlights,
      contexts,
    },
    findings,
  };
}
