import type { Database } from "bun:sqlite";
import { itemById } from "./db.ts";
import {
  healthState,
  retainedWorkHealth,
  sourceHealthReport,
} from "./health.ts";
import { readItem } from "./store.ts";
import type { ItemStatus, SourceKind } from "./types.ts";
import { capabilityMode, loadConfig, type OptionalCapability } from "./config.ts";

const SOURCES: SourceKind[] = [
  "shortcut",
  "icloud_file",
  "reading_list",
  "newsletter",
  "highlight_share",
  "local_capture",
  "x_bookmark",
];
const STATUSES: ItemStatus[] = [
  "stub",
  "captured",
  "fetch_failed",
  "has_body",
  "enriched",
];

export interface StructuredSearchRequest {
  query: string;
  from?: string;
  to?: string;
  sources?: SourceKind[];
  statuses?: ItemStatus[];
  tags?: string[];
  limit?: number;
}

export interface StructuredSearchHit {
  id: string;
  title: string | null;
  url: string | null;
  status: ItemStatus;
  sources: SourceKind[];
  capturedAt: string;
  publishedAt: string | null;
  tags: string[];
  mdPath: string;
  bodyAvailable: boolean;
  matchField: "body" | "highlight" | "context" | "title";
  snippet: string;
}

export interface StructuredSearchResult {
  version: 1;
  operation: "search";
  query: {
    text: string;
    from?: string;
    to?: string;
    sources?: SourceKind[];
    statuses?: ItemStatus[];
    tags?: string[];
    limit: number;
  };
  count: number;
  hasMore: boolean;
  hits: StructuredSearchHit[];
}

export interface StructuredItemResult {
  version: 1;
  operation: "get";
  item: {
    id: string;
    title: string | null;
    url: string | null;
    status: ItemStatus;
    sources: SourceKind[];
    capturedAt: string;
    publishedAt: string | null;
    tags: string[];
    summary: string | null;
    mdPath: string;
    bodyAvailable: boolean;
    body: { text: string; totalChars: number; truncated: boolean } | null;
    evidenceLimits: { bodyMaxChars: number; listMaxItems: number; entryMaxChars: number };
    highlightCount: number;
    highlightsTruncated: boolean;
    highlights: Array<{
      id: string;
      origin: "manual" | "ai";
      text: string;
      truncated: boolean;
    }>;
    contextCount: number;
    contextsTruncated: boolean;
    contexts: Array<{
      id: string;
      kind: "shared_text" | "note";
      source: SourceKind;
      text: string;
      truncated: boolean;
      capturedAt: string;
    }>;
  };
}

export interface StructuredRecentCursor {
  capturedAt: string;
  id: string;
}

export interface StructuredRecentRequest {
  from?: string;
  sources?: SourceKind[];
  cursor?: StructuredRecentCursor;
  limit?: number;
}

export interface StructuredRecentResult {
  version: 1;
  operation: "recent";
  query: {
    from?: string;
    sources?: SourceKind[];
    cursor?: StructuredRecentCursor;
    limit: number;
  };
  count: number;
  hasMore: boolean;
  nextCursor: StructuredRecentCursor | null;
  items: Array<{
    id: string;
    title: string | null;
    url: string | null;
    status: ItemStatus;
    sources: SourceKind[];
    capturedAt: string;
    publishedAt: string | null;
    tags: string[];
    mdPath: string;
    bodyAvailable: boolean;
  }>;
}

export interface StructuredHealthResult {
  version: 1;
  operation: "health";
  healthy: boolean;
  components: Array<{
    name: string;
    state:
      | "healthy"
      | "stale"
      | "failed"
      | "never_run"
      | "disabled"
      | "unconfigured";
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastNewItemAt: string | null;
    lastError: string | null;
    consecutiveFailures: number;
  }>;
  retainedWork: Array<{
    component: "raw_spool" | "writer_intents";
    count: number;
    oldestPath: string;
    oldestAgeMinutes: number;
  }>;
}

const EXPECTED_HEALTH = [
  "local_capture",
  "worker_inbox",
  "icloud_inbox",
  "reading_list",
  "job:daemon",
  "job:enrichment",
  "job:resurface",
  "job:digest",
] as const;

const EVIDENCE_LIST_MAX = 50;
const EVIDENCE_ENTRY_MAX_CHARS = 4_000;

function redactSensitive(message: string | null): string | null {
  if (message === null) return null;
  return message
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/\b(token|secret|password|api[_-]?key|key)=([^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk|ghp)_[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("structured search request must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(
  input: Record<string, unknown>,
  allowed: readonly string[],
  operation: string,
): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new Error(`${operation} request contains unsupported field: ${unknown.sort().join(", ")}`);
  }
}

function stringList<T extends string>(
  value: unknown,
  field: string,
  allowed?: readonly T[],
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error(`${field} must be an array of 1-20 strings`);
  }
  const out = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 100) {
      throw new Error(`${field} must contain non-empty strings up to 100 characters`);
    }
    const normalized = entry.trim() as T;
    if (allowed && !allowed.includes(normalized)) {
      throw new Error(`${field} contains unsupported value: ${normalized}`);
    }
    return normalized;
  });
  return [...new Set(out)];
}

function instant(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be an ISO date or date-time`);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) throw new Error(`${field} must be an ISO date or date-time with a timezone`);
  const [, year, month, day, hour, minute, second] = match;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    calendar.getUTCFullYear() !== Number(year) ||
    calendar.getUTCMonth() !== Number(month) - 1 ||
    calendar.getUTCDate() !== Number(day) ||
    (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59))
  ) {
    throw new Error(`${field} must be a valid ISO date or date-time`);
  }
  const expanded = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00.000Z`
    : value;
  const date = new Date(expanded);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${field} must be an ISO date or date-time`);
  }
  return date.toISOString();
}

export function parseStructuredSearchRequest(
  value: unknown,
): Required<Pick<StructuredSearchRequest, "query" | "limit">> &
  Omit<StructuredSearchRequest, "query" | "limit"> {
  const input = object(value);
  rejectUnknown(
    input,
    ["query", "from", "to", "sources", "statuses", "tags", "limit"],
    "search",
  );
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query || query.length > 512) {
    throw new Error("query must be 1-512 characters");
  }
  const limit = input.limit === undefined ? 20 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer from 1 to 100");
  }
  const from = instant(input.from, "from");
  const to = instant(input.to, "to");
  if (from && to && from >= to) throw new Error("from must be earlier than to");
  return {
    query,
    limit,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(input.sources !== undefined
      ? { sources: stringList(input.sources, "sources", SOURCES)! }
      : {}),
    ...(input.statuses !== undefined
      ? { statuses: stringList(input.statuses, "statuses", STATUSES)! }
      : {}),
    ...(input.tags !== undefined
      ? { tags: stringList(input.tags, "tags")! }
      : {}),
  };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function structuredSearch(
  db: Database,
  rawRequest: unknown,
): StructuredSearchResult {
  const request = parseStructuredSearchRequest(rawRequest);
  const where = ["items_fts MATCH ?"];
  const params: Array<string | number> = [request.query];
  if (request.from) {
    where.push("i.captured_at >= ?");
    params.push(request.from);
  }
  if (request.to) {
    where.push("i.captured_at < ?");
    params.push(request.to);
  }
  if (request.sources) {
    where.push(
      `EXISTS (SELECT 1 FROM json_each(i.sources) WHERE value IN (${placeholders(request.sources.length)}))`,
    );
    params.push(...request.sources);
  }
  if (request.statuses) {
    where.push(`i.status IN (${placeholders(request.statuses.length)})`);
    params.push(...request.statuses);
  }
  if (request.tags) {
    where.push(
      `EXISTS (SELECT 1 FROM json_each(i.tags) WHERE value IN (${placeholders(request.tags.length)}))`,
    );
    params.push(...request.tags);
  }
  params.push(request.limit + 1);

  let rows: Array<{
    id: string;
    title: string | null;
    url: string | null;
    status: ItemStatus;
    sources: string;
    captured_at: string;
    published_at: string | null;
    tags: string;
    md_path: string;
    body_hash: string | null;
    title_snip: string;
    body_snip: string;
    highlight_snip: string;
    context_snip: string;
  }>;
  try {
    rows = db.query(
      `SELECT i.id, i.title, i.url, i.status, i.sources, i.captured_at,
              i.published_at, i.tags, i.md_path, i.body_hash,
              snippet(items_fts, 1, char(1), char(2), '…', 12) AS title_snip,
              snippet(items_fts, 2, char(1), char(2), '…', 12) AS body_snip,
              snippet(items_fts, 3, char(1), char(2), '…', 12) AS highlight_snip,
              snippet(items_fts, 4, char(1), char(2), '…', 12) AS context_snip
       FROM items_fts
       JOIN items i ON i.id = items_fts.item_id
       WHERE ${where.join(" AND ")}
       ORDER BY rank, i.captured_at DESC, i.id
       LIMIT ?`,
    ).all(...params) as typeof rows;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid full-text query: ${reason}`);
  }

  const hasMore = rows.length > request.limit;
  const hits = rows.slice(0, request.limit).map((row): StructuredSearchHit => {
    const candidates = [
      ["body", row.body_snip],
      ["highlight", row.highlight_snip],
      ["context", row.context_snip],
      ["title", row.title_snip],
    ] as const;
    const matched = candidates.find(([, snippet]) => snippet.includes("\u0001"))
      ?? candidates.find(([, snippet]) => Boolean(snippet))
      ?? ["title", ""] as const;
    return {
      id: row.id,
      title: row.title,
      url: row.url,
      status: row.status,
      sources: JSON.parse(row.sources),
      capturedAt: row.captured_at,
      publishedAt: row.published_at,
      tags: JSON.parse(row.tags),
      mdPath: row.md_path,
      bodyAvailable: row.body_hash !== null,
      matchField: matched[0],
      snippet: matched[1].replaceAll("\u0001", "[").replaceAll("\u0002", "]"),
    };
  });
  return {
    version: 1,
    operation: "search",
    query: {
      text: request.query,
      ...(request.from ? { from: request.from } : {}),
      ...(request.to ? { to: request.to } : {}),
      ...(request.sources ? { sources: request.sources } : {}),
      ...(request.statuses ? { statuses: request.statuses } : {}),
      ...(request.tags ? { tags: request.tags } : {}),
      limit: request.limit,
    },
    count: hits.length,
    hasMore,
    hits,
  };
}

export function structuredItem(
  repoRoot: string,
  db: Database,
  rawRequest: unknown,
): StructuredItemResult {
  const input = object(rawRequest);
  rejectUnknown(input, ["id", "maxChars"], "get");
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!/^pt_[a-z0-9]{10}$/.test(id)) throw new Error("id must be a Wordhold item id");
  const maxChars = input.maxChars === undefined ? 8_000 : Number(input.maxChars);
  if (!Number.isInteger(maxChars) || maxChars < 200 || maxChars > 50_000) {
    throw new Error("maxChars must be an integer from 200 to 50000");
  }
  const item = itemById(db, id);
  if (!item) throw new Error(`item not found: ${id}`);
  const canonical = readItem(repoRoot, item.mdPath);
  const body = canonical.body;
  const highlights = canonical.highlights.slice(0, EVIDENCE_LIST_MAX);
  const contexts = canonical.frontmatter.capture_contexts.slice(0, EVIDENCE_LIST_MAX);
  return {
    version: 1,
    operation: "get",
    item: {
      id: item.id,
      title: item.title,
      url: item.url,
      status: item.status,
      sources: item.sources,
      capturedAt: item.capturedAt,
      publishedAt: item.publishedAt,
      tags: item.tags,
      summary: item.summary,
      mdPath: item.mdPath,
      bodyAvailable: body.length > 0,
      body: body
        ? {
            text: body.slice(0, maxChars),
            totalChars: body.length,
            truncated: body.length > maxChars,
          }
        : null,
      evidenceLimits: {
        bodyMaxChars: maxChars,
        listMaxItems: EVIDENCE_LIST_MAX,
        entryMaxChars: EVIDENCE_ENTRY_MAX_CHARS,
      },
      highlightCount: canonical.highlights.length,
      highlightsTruncated: canonical.highlights.length > highlights.length,
      highlights: highlights.map((highlight) => ({
        id: highlight.id,
        origin: highlight.origin,
        text: highlight.text.slice(0, EVIDENCE_ENTRY_MAX_CHARS),
        truncated: highlight.text.length > EVIDENCE_ENTRY_MAX_CHARS,
      })),
      contextCount: canonical.frontmatter.capture_contexts.length,
      contextsTruncated: canonical.frontmatter.capture_contexts.length > contexts.length,
      contexts: contexts.map((context) => ({
        id: context.id,
        kind: context.kind,
        source: context.source,
        text: context.text.slice(0, EVIDENCE_ENTRY_MAX_CHARS),
        truncated: context.text.length > EVIDENCE_ENTRY_MAX_CHARS,
        capturedAt: context.captured_at,
      })),
    },
  };
}

export function structuredRecent(
  db: Database,
  rawRequest: unknown,
): StructuredRecentResult {
  const input = object(rawRequest);
  rejectUnknown(input, ["from", "sources", "cursor", "limit"], "recent");
  const limit = input.limit === undefined ? 20 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer from 1 to 100");
  }
  const from = instant(input.from, "from");
  const sources = input.sources === undefined
    ? undefined
    : stringList(input.sources, "sources", SOURCES)!;
  let cursor: StructuredRecentCursor | undefined;
  if (input.cursor !== undefined) {
    const rawCursor = object(input.cursor);
    rejectUnknown(rawCursor, ["capturedAt", "id"], "recent cursor");
    if (typeof rawCursor.capturedAt !== "string" || !rawCursor.capturedAt.includes("T")) {
      throw new Error("cursor.capturedAt must be an ISO date-time");
    }
    const capturedAt = instant(rawCursor.capturedAt, "cursor.capturedAt");
    const id = typeof rawCursor.id === "string" ? rawCursor.id.trim() : "";
    if (!capturedAt) {
      throw new Error("cursor.capturedAt must be an ISO date-time");
    }
    if (!/^pt_[a-z0-9]{10}$/.test(id)) {
      throw new Error("cursor.id must be a Wordhold item id");
    }
    cursor = { capturedAt, id };
  }

  const where: string[] = [];
  const params: Array<string | number> = [];
  if (from) {
    where.push("captured_at >= ?");
    params.push(from);
  }
  if (sources) {
    where.push(
      `EXISTS (SELECT 1 FROM json_each(items.sources) WHERE value IN (${placeholders(sources.length)}))`,
    );
    params.push(...sources);
  }
  if (cursor) {
    where.push("(captured_at < ? OR (captured_at = ? AND id < ?))");
    params.push(cursor.capturedAt, cursor.capturedAt, cursor.id);
  }
  params.push(limit + 1);

  const rows = db.query(
    `SELECT id, title, url, status, sources, captured_at, published_at,
            tags, md_path, body_hash
     FROM items
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY captured_at DESC, id DESC
     LIMIT ?`,
  ).all(...params) as Array<{
    id: string;
    title: string | null;
    url: string | null;
    status: ItemStatus;
    sources: string;
    captured_at: string;
    published_at: string | null;
    tags: string;
    md_path: string;
    body_hash: string | null;
  }>;
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => ({
    id: row.id,
    title: row.title,
    url: row.url,
    status: row.status,
    sources: JSON.parse(row.sources) as SourceKind[],
    capturedAt: row.captured_at,
    publishedAt: row.published_at,
    tags: JSON.parse(row.tags) as string[],
    mdPath: row.md_path,
    bodyAvailable: row.body_hash !== null,
  }));
  return {
    version: 1,
    operation: "recent",
    query: {
      ...(from ? { from } : {}),
      ...(sources ? { sources } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
    },
    count: items.length,
    hasMore,
    nextCursor: hasMore && items.length > 0
      ? {
          capturedAt: items[items.length - 1]!.capturedAt,
          id: items[items.length - 1]!.id,
        }
      : null,
    items,
  };
}

export function structuredHealth(
  repoRoot: string,
  db: Database,
  rawRequest: unknown,
): StructuredHealthResult {
  const input = object(rawRequest);
  rejectUnknown(input, [], "health");
  const rows = sourceHealthReport(db);
  const bySource = new Map(rows.map((row) => [row.source, row]));
  const capabilitySources: Array<[OptionalCapability, string]> = [
    ["workerInbox", "worker_inbox"],
    ["icloudInbox", "icloud_inbox"],
    ["readingList", "reading_list"],
    ["enrichment", "job:enrichment"],
    ["resurfacing", "job:resurface"],
    ["digest", "job:digest"],
  ];
  let explicitConfig: ReturnType<typeof loadConfig> | null = null;
  try {
    explicitConfig = loadConfig(repoRoot);
  } catch {
    // Health is still useful for an uninitialized/legacy test root and must not
    // turn a missing config into implicit executable defaults.
  }
  const explicitCapabilities = explicitConfig?.capabilities !== undefined;
  const capabilityComponents: StructuredHealthResult["components"] = [];
  const activeNames = new Set<string>(["local_capture", "job:daemon"]);
  if (explicitCapabilities) {
    for (const [capability, source] of capabilitySources) {
      const mode = capabilityMode(explicitConfig!, capability);
      if (mode === "enabled") {
        activeNames.add(source);
      } else {
        capabilityComponents.push({
          name: source,
          state: mode,
          lastRunAt: null,
          lastSuccessAt: null,
          lastNewItemAt: null,
          lastError: null,
          consecutiveFailures: 0,
        });
      }
    }
  } else {
    for (const name of EXPECTED_HEALTH) activeNames.add(name);
  }
  const managedSources = new Set(capabilitySources.map(([, source]) => source));
  for (const row of rows) {
    if (!managedSources.has(row.source) || activeNames.has(row.source)) {
      activeNames.add(row.source);
    }
  }
  const names = [...activeNames];
  const components: StructuredHealthResult["components"] = names.map((name) => {
    const row = bySource.get(name);
    if (!row) {
      return {
        name,
        state: "never_run",
        lastRunAt: null,
        lastSuccessAt: null,
        lastNewItemAt: null,
        lastError: null,
        consecutiveFailures: 0,
      };
    }
    const state = healthState(row);
    return {
      name,
      state: state === "ok" ? "healthy" : state === "STALE" ? "stale" : "failed",
      lastRunAt: row.lastRunAt,
      lastSuccessAt: row.lastSuccessAt,
      lastNewItemAt: row.lastNewItemAt,
      lastError: redactSensitive(row.lastError),
      consecutiveFailures: row.consecutiveFailures,
    };
  });
  components.push(...capabilityComponents);
  components.sort((a, b) => a.name.localeCompare(b.name));
  const retainedWork = retainedWorkHealth(repoRoot);
  return {
    version: 1,
    operation: "health",
    healthy:
      components.every(
        (component) => component.state === "healthy" || component.state === "disabled",
      ) &&
      retainedWork.length === 0,
    components,
    retainedWork,
  };
}
