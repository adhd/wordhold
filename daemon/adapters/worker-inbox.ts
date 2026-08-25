// Drains the Cloudflare Worker inbox over /v1/drain, paginated. Rows are
// deleted worker-side only via ack() after the store commits (invariant:
// acknowledged captures are never lost). Quarantined rows never become
// captures and stay in the inbox un-acked until allowlisted.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendPrivateFile } from "../../core/private-fs.ts";
import { workerOrigin } from "../../core/web-url.ts";
import {
  AdapterHardError,
  type AdapterContext,
  type Capture,
  type SourceAdapter,
} from "../../core/types.ts";
import { log } from "../../core/log.ts";
import {
  canonicalIsoTimestamp,
  parseIdempotencyKey,
  parseSaveHighlightPayload,
} from "../../core/capture-input.ts";

export interface WorkerInboxRow {
  id: string; // inbox row uuid; doubles as the capture idempotency key
  kind: "save" | "highlight" | "note" | "email";
  receivedAt: string;
  quarantined?: boolean;
  payload: {
    url?: string;
    title?: string;
    text?: string;
    capturedAt?: string;
    // email-only fields
    html?: string;
    from?: string;
    subject?: string;
    listPost?: string; // canonical web URL from List-Post / body link
    date?: string; // parsed Date header
    bodyKey?: string; // R2 body object; fetched separately to keep drain pages small
    error?: string;
    idempotencyKey?: string;
  };
}

interface DrainResponse {
  rows: WorkerInboxRow[];
  quarantinedRows?: WorkerInboxRow[];
  nextCursor?: string | null;
}

// Keep the worst-case JSON response below the adapter's 2 MiB response cap:
// 32 maximum-size capture bodies plus bounded quarantine metadata and framing.
const PAGE_LIMIT = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CAPTURES_PER_RUN = 200;
const DEFAULT_MAX_PAGES_PER_RUN = 20;
const DEFAULT_MAX_BODY_BYTES_PER_RUN = 64 * 1024 * 1024;
const MAX_METADATA_RESPONSE_BYTES = 2 * 1024 * 1024;

class ResponseTooLargeError extends Error {
  constructor(
    public path: string,
    public maxBytes: number,
  ) {
    super(`worker ${path} exceeded ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

export interface WorkerInboxAdapter extends SourceAdapter {
  // Set by pull() when worker.baseUrl is empty (worker not deployed yet).
  readonly note: string | undefined;
}

export type WorkerFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function rowToCapture(row: WorkerInboxRow): Capture | null {
  const p = row.payload ?? {};
  if (row.kind === "save" || row.kind === "highlight" || row.kind === "note") {
    const parsed = parseSaveHighlightPayload(row.kind, p);
    const idempotencyKey = parseIdempotencyKey(p.idempotencyKey) ?? row.id;
    const capturedAt = parsed.capturedAt ?? canonicalIsoTimestamp(row.receivedAt);
    return {
      kind: row.kind,
      source: row.kind === "highlight" ? "highlight_share" : "shortcut",
      ...parsed,
      capturedAt,
      idempotencyKey,
      upstreamId: row.id,
    };
  }
  if (row.kind === "email") {
    const receivedAt = canonicalIsoTimestamp(row.receivedAt);
    let capturedAt = receivedAt;
    if (typeof p.date === "string") {
      try {
        capturedAt = canonicalIsoTimestamp(p.date);
      } catch {
        // Date is sender-controlled metadata; Worker receipt time is trusted.
      }
    }
    return {
      kind: "email",
      source: "newsletter",
      url: p.listPost ?? undefined,
      emailFrom: p.from,
      emailSubject: p.subject,
      text: p.text,
      html: p.html,
      capturedAt,
      idempotencyKey: row.id,
      upstreamId: row.id,
    };
  }
  return null; // unknown kind: leave un-acked rather than guess
}

function logInvalidRows(
  repoRoot: string,
  rows: Array<{ row: WorkerInboxRow; reason: string }>,
): void {
  if (rows.length === 0) return;
  const dir = join(repoRoot, "logs");
  const seenPath = join(dir, "bad-worker-captures-seen.txt");
  const seen = new Set(
    existsSync(seenPath)
      ? readFileSync(seenPath, "utf8").split("\n").filter(Boolean)
      : [],
  );
  let lines = "";
  let ids = "";
  for (const { row, reason } of rows) {
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    lines +=
      JSON.stringify({
        at: new Date().toISOString(),
        id: row.id,
        kind: row.kind,
        reason,
      }) + "\n";
    ids += row.id + "\n";
  }
  if (!lines) return;
  appendPrivateFile(join(dir, "bad-worker-captures.jsonl"), lines);
  appendPrivateFile(seenPath, ids);
}

function seenIds(path: string): Set<string> {
  return new Set(
    existsSync(path)
      ? readFileSync(path, "utf8").split("\n").filter(Boolean)
      : [],
  );
}

function logOversizedBody(
  repoRoot: string,
  row: WorkerInboxRow,
  maxBytes: number,
): void {
  const dir = join(repoRoot, "logs");
  appendPrivateFile(
    join(dir, "oversized-worker-bodies.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      id: row.id,
      from: row.payload?.from,
      subject: row.payload?.subject,
      maxBytes,
    }) + "\n",
  );
  appendPrivateFile(join(dir, "oversized-worker-bodies-seen.txt"), row.id + "\n");
}

async function boundedResponse(
  source: Response,
  path: string,
  maxBytes: number,
): Promise<Response> {
  const declared = Number(source.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await source.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(path, maxBytes);
  }
  if (!source.body) {
    return new Response(null, {
      status: source.status,
      statusText: source.statusText,
      headers: source.headers,
    });
  }

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(path, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(total ? bytes : null, {
    status: source.status,
    statusText: source.statusText,
    headers: source.headers,
  });
}

// Appends one {at, from, subject} line per newly seen quarantined row.
// Row ids already logged live in quarantine-seen.txt so re-pulls of the same
// un-acked rows do not duplicate lines.
function logQuarantined(repoRoot: string, rows: WorkerInboxRow[]): void {
  if (rows.length === 0) return;
  const dir = join(repoRoot, "logs");
  const seenPath = join(dir, "quarantine-seen.txt");
  const seen = new Set(
    existsSync(seenPath)
      ? readFileSync(seenPath, "utf8").split("\n").filter(Boolean)
      : [],
  );
  let lines = "";
  let ids = "";
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    lines +=
      JSON.stringify({
        at: row.receivedAt,
        from: row.payload?.from,
        subject: row.payload?.subject,
        ...(row.payload?.error ? { error: row.payload.error } : {}),
      }) + "\n";
    ids += row.id + "\n";
  }
  if (!lines) return;
  appendPrivateFile(join(dir, "quarantine.jsonl"), lines);
  appendPrivateFile(seenPath, ids);
}

export function createWorkerInboxAdapter(
  deps: {
    fetchFn?: WorkerFetch;
    requestTimeoutMs?: number;
    maxCapturesPerRun?: number;
    maxPagesPerRun?: number;
    maxBodyBytesPerRun?: number;
  } = {},
): WorkerInboxAdapter {
  const fetchFn = deps.fetchFn ?? fetch;
  const requestTimeoutMs =
    deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxCapturesPerRun =
    deps.maxCapturesPerRun ?? DEFAULT_MAX_CAPTURES_PER_RUN;
  const maxPagesPerRun = deps.maxPagesPerRun ?? DEFAULT_MAX_PAGES_PER_RUN;
  const maxBodyBytesPerRun =
    deps.maxBodyBytesPerRun ?? DEFAULT_MAX_BODY_BYTES_PER_RUN;
  let note: string | undefined;

  async function call(
    ctx: AdapterContext,
    path: string,
    init?: RequestInit,
    maxResponseBytes = MAX_METADATA_RESPONSE_BYTES,
  ): Promise<Response> {
    const base = workerOrigin(ctx.config.worker.baseUrl, {
      // Private HTTP origins remain useful for explicit local deployments and
      // injected test servers. The shared helper still rejects path/query drift.
      allowHttp: true,
      allowPrivate: true,
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let res: Response;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`worker ${path} timed out after ${requestTimeoutMs}ms`));
        }, requestTimeoutMs);
      });
      const request = (async () => {
        const source = await fetchFn(`${base}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${ctx.config.worker.secret}`,
            ...(init?.headers ?? {}),
          },
        });
        // Materialize inside both the deadline and byte cap. Returning headers
        // alone is not complete when a stream can stall or grow indefinitely.
        return boundedResponse(source, path, maxResponseBytes);
      })();
      res = await Promise.race([request, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      throw new AdapterHardError(
        "worker_inbox",
        `worker returned ${res.status} for ${path}: secret rejected; check worker.secret against the deployed worker`,
      );
    }
    if (!res.ok) throw new Error(`worker ${path} returned HTTP ${res.status}`);
    return res;
  }

  return {
    name: "worker_inbox",
    get note() {
      return note;
    },

    async pull(ctx: AdapterContext): Promise<Capture[]> {
      note = undefined;
      if (!ctx.config.worker.baseUrl) {
        note = "worker.baseUrl empty; worker not deployed yet";
        return [];
      }
      const captures: Capture[] = [];
      const quarantined: WorkerInboxRow[] = [];
      const invalidRows: Array<{ row: WorkerInboxRow; reason: string }> = [];
      const oversizedPath = join(
        ctx.repoRoot,
        "logs",
        "oversized-worker-bodies-seen.txt",
      );
      const oversizedBodyIds = seenIds(oversizedPath);
      let cursor: string | undefined;
      let pages = 0;
      let bodyBytes = 0;
      drain: for (;;) {
        const qs = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
        const res = await call(ctx, `/v1/drain?limit=${PAGE_LIMIT}${qs}`);
        const page = (await res.json()) as DrainResponse;
        const rows = page.rows ?? [];
        quarantined.push(...(page.quarantinedRows ?? []));
        pages += 1;
        for (const row of rows) {
          if (row.quarantined) {
            quarantined.push(row);
            continue;
          }
          let hydrated = row;
          if (row.kind === "email" && row.payload?.bodyKey) {
            if (oversizedBodyIds.has(row.id)) continue;
            let bodyRes: Response;
            try {
              bodyRes = await call(
                ctx,
                `/v1/body/${encodeURIComponent(row.id)}`,
                undefined,
                maxBodyBytesPerRun,
              );
            } catch (error) {
              if (!(error instanceof ResponseTooLargeError)) throw error;
              logOversizedBody(ctx.repoRoot, row, error.maxBytes);
              oversizedBodyIds.add(row.id);
              continue;
            }
            const rawBody = await bodyRes.text();
            const nextBodyBytes = new TextEncoder().encode(rawBody).byteLength;
            if (bodyBytes + nextBodyBytes > maxBodyBytesPerRun) {
              log(
                ctx.repoRoot,
                "worker_inbox",
                `body budget reached after ${captures.length} captures; remaining rows deferred`,
              );
              break drain;
            }
            bodyBytes += nextBodyBytes;
            const body = JSON.parse(rawBody) as {
              text?: string;
              html?: string;
            };
            hydrated = {
              ...row,
              payload: { ...row.payload, text: body.text, html: body.html },
            };
          }
          try {
            const c = rowToCapture(hydrated);
            if (c) captures.push(c);
          } catch (error) {
            invalidRows.push({
              row,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
          if (captures.length >= maxCapturesPerRun) break drain;
        }
        if (!page.nextCursor || rows.length === 0) break;
        if (pages >= maxPagesPerRun) {
          log(
            ctx.repoRoot,
            "worker_inbox",
            `page budget reached after ${pages} pages; remaining rows deferred`,
          );
          break;
        }
        cursor = page.nextCursor;
      }
      logQuarantined(ctx.repoRoot, quarantined);
      const quarantineErrors = quarantined.filter(
        (row) => typeof row.payload?.error === "string",
      ).length;
      if (quarantineErrors > 0) {
        note = `${quarantineErrors} quarantined email(s) require attention; see logs/quarantine.jsonl`;
      }
      logInvalidRows(ctx.repoRoot, invalidRows);
      return captures;
    },

    async ack(ctx: AdapterContext, accepted: Capture[]): Promise<void> {
      if (!ctx.config.worker.baseUrl) return;
      const ids = accepted
        // Canonical replay identity may be shared with an iCloud copy; only
        // the opaque Worker row id is valid at the acknowledgement boundary.
        // Fall back for raw spool entries created before upstreamId existed.
        .map((c) => c.upstreamId ?? c.idempotencyKey)
        .filter((k): k is string => typeof k === "string" && k.length > 0);
      if (ids.length === 0) return;
      await call(ctx, "/v1/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
    },
  };
}
