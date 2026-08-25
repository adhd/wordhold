// Cloudflare Worker inbox: durable buffer between capture sources and the Mac
// daemon. Rows leave only via explicit /v1/ack after the daemon has committed
// them locally. No time-based eviction, ever.

import type {
  D1Database,
  ForwardableEmailMessage,
  R2Bucket,
} from "@cloudflare/workers-types";
import {
  handleEmail,
  insertInboxRow,
  mintInboxId,
  allowedSenderKey,
  type InboundEmail,
} from "./email.ts";
import {
  clipUtf8,
  MAX_CAPTURE_JSON_BYTES,
  parseIdempotencyKey,
  parseSaveHighlightPayload,
  utf8Length,
} from "../../core/capture-input.ts";

export interface Env {
  INBOX: D1Database;
  BODIES: R2Bucket;
  SECRET: string;
  CAPTURE_SECRET?: string;
}

const DRAIN_SQL =
  "SELECT id, kind, payload, received_at, quarantined FROM inbox WHERE quarantined = 0 AND id > ? ORDER BY id LIMIT ?";
const QUARANTINE_SAMPLE_SQL =
  "SELECT id, kind, payload, received_at, quarantined FROM inbox WHERE quarantined = 1 ORDER BY id DESC LIMIT ?";
const QUARANTINED_EMAILS_SQL =
  "SELECT id, payload, received_at FROM inbox WHERE kind = 'email' AND quarantined = 1";
const ALLOW_SENDER_SQL =
  "INSERT OR REPLACE INTO senders (address, allowed_at) VALUES (?, ?)";
const LIST_SENDERS_SQL = "SELECT address FROM senders ORDER BY address";
const LEGACY_QUARANTINE_SQL =
  "SELECT id, payload, received_at FROM inbox WHERE kind = 'email' AND quarantined = 1 AND json_extract(payload, '$.bodyKey') IS NOT NULL AND id > ? ORDER BY id LIMIT ?";

const MAX_DRAIN_LIMIT = 200;
const SQL_CHUNK = 50; // stay well under D1's bound-parameter cap
const PENDING_EMAIL_PREFIX = "email-pending/";
const ACKED_EMAIL_PREFIX = "email-acked/";
const RECOVERY_SCAN_LIMIT = 200;
const RECOVERY_PROMOTION_LIMIT = 5;
const QUARANTINE_SAMPLE_LIMIT = 50;
const RECOVERY_CURSOR_KEY = "recovery-state/email-pending-cursor";
const LEGACY_RECOVERY_CURSOR_KEY = "recovery-state/legacy-quarantine-cursor";
const MAX_DRAIN_PAYLOAD_BYTES = 40 * 1024;
const REQUEST_TOO_LARGE = Symbol("request-too-large");

function pendingEmailKey(id: string): string {
  return `${PENDING_EMAIL_PREFIX}${id}.json`;
}

function ackedEmailKey(id: string): string {
  return `${ACKED_EMAIL_PREFIX}${encodeURIComponent(id)}`;
}

function pendingEmailId(key: string): string | null {
  if (!key.startsWith(PENDING_EMAIL_PREFIX) || !key.endsWith(".json")) {
    return null;
  }
  const id = key.slice(PENDING_EMAIL_PREFIX.length, -".json".length);
  return id || null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
}

function authorizationRole(
  request: Request,
  env: Pick<Env, "SECRET" | "CAPTURE_SECRET">,
): "admin" | "capture" | null {
  const token = bearerToken(request);
  if (env.SECRET && timingSafeEqualStr(token, env.SECRET)) return "admin";
  if (
    env.CAPTURE_SECRET &&
    timingSafeEqualStr(token, env.CAPTURE_SECRET)
  ) {
    return "capture";
  }
  return null;
}

async function readJson(
  request: Request,
): Promise<Record<string, unknown> | null | typeof REQUEST_TOO_LARGE> {
  try {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_CAPTURE_JSON_BYTES) {
      return REQUEST_TOO_LARGE;
    }
    if (!request.body) return null;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_CAPTURE_JSON_BYTES) {
          await reader.cancel().catch(() => undefined);
          return REQUEST_TOO_LARGE;
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
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function handleCapture(
  request: Request,
  db: D1Database,
  kind: "save" | "highlight" | "note",
  parsedBody?: Record<string, unknown> | null,
): Promise<Response> {
  const body = parsedBody === undefined ? await readJson(request) : parsedBody;
  if (body === REQUEST_TOO_LARGE) {
    return json({ error: "capture request is too large" }, 400);
  }
  let payload;
  try {
    payload = parseSaveHighlightPayload(kind, body);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "invalid capture" },
      400,
    );
  }
  let rawKey: string | undefined;
  try {
    rawKey = parseIdempotencyKey(body?.idempotencyKey);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid idempotencyKey" }, 400);
  }
  const persistedPayload = {
    ...payload,
    ...(rawKey ? { idempotencyKey: rawKey } : {}),
  };
  if (utf8Length(JSON.stringify(persistedPayload)) > MAX_DRAIN_PAYLOAD_BYTES) {
    return json({ error: "serialized capture payload is too large" }, 400);
  }
  const id = typeof rawKey === "string"
    ? await deterministicInboxId(kind, rawKey)
    : mintInboxId();
  await insertInboxRow(db, {
    id,
    kind,
    payload: persistedPayload,
    receivedAt: new Date().toISOString(),
    quarantined: 0,
  }, { ignoreExisting: typeof rawKey === "string" });
  return json({ id });
}

async function deterministicInboxId(
  kind: "save" | "highlight" | "note",
  key: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${kind}\n${key}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `in_idem_${hex.slice(0, 40)}`;
}

async function handleDrain(url: URL, db: D1Database): Promise<Response> {
  const rawLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_DRAIN_LIMIT)
    : 50;
  const cursor = url.searchParams.get("cursor") ?? "";
  const res = await db.prepare(DRAIN_SQL).bind(cursor, limit).all();
  const rows = mapInboxRows(res.results ?? []);
  const quarantinedRows = cursor
    ? []
    : mapInboxRows(
        (
          await db
            .prepare(QUARANTINE_SAMPLE_SQL)
            .bind(QUARANTINE_SAMPLE_LIMIT)
            .all()
        ).results ?? [],
      );
  const nextCursor = rows.length === limit ? rows[rows.length - 1]!.id : null;
  return json({ rows, quarantinedRows, nextCursor });
}

function mapInboxRows(results: unknown[]): Array<{
  id: string;
  kind: string;
  payload: unknown;
  receivedAt: string;
  quarantined: boolean;
}> {
  return results.map((r) => {
    const row = r as Record<string, unknown>;
    const payloadText = String(row.payload ?? "");
    const parsed = parsePayload(payloadText);
    const quarantined = Boolean(row.quarantined);
    const oversized = utf8Length(payloadText) > MAX_DRAIN_PAYLOAD_BYTES;
    return {
      id: row.id as string,
      kind: row.kind as string,
      payload: quarantined || oversized
        ? boundedQuarantineMetadata(parsed)
        : parsed,
      receivedAt: row.received_at as string,
      quarantined: quarantined || oversized,
    };
  });
}

function boundedQuarantineMetadata(payload: unknown): Record<string, unknown> {
  const input =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const clipped = (key: string, bytes: number) =>
    typeof input[key] === "string"
      ? clipUtf8(input[key] as string, bytes)
      : undefined;
  const from = clipped("from", 512);
  const subject = clipped("subject", 8 * 1024);
  return {
    ...(from ? { from } : {}),
    ...(subject ? { subject } : {}),
    error: "payload_too_large",
  };
}

async function retireLegacyQuarantine(
  env: Env,
  id: string,
  bodyKey: string,
  payload: unknown,
  receivedAt: string,
  indexed: boolean,
  tombstoneExists: boolean,
): Promise<void> {
  const metadata = boundedQuarantineMetadata(payload);
  metadata.error = "legacy_quarantine_requires_resend";
  if (indexed) {
    await env.INBOX
      .prepare("UPDATE inbox SET payload = ? WHERE id = ?")
      .bind(JSON.stringify(metadata), id)
      .run();
  } else {
    await env.INBOX
      .prepare(
        "INSERT OR IGNORE INTO inbox (id, kind, payload, received_at, quarantined) VALUES (?, ?, ?, ?, 1)",
      )
      .bind(id, "email", JSON.stringify(metadata), receivedAt)
      .run();
  }
  // D1 is now self-contained. Tombstone before deleting the legacy body so
  // recovery cannot recreate an evicted row after either boundary.
  if (!tombstoneExists) await env.BODIES.put(ackedEmailKey(id), "");
  await env.BODIES.delete(bodyKey);
  await pruneMigratedQuarantine(env.INBOX);
}

async function sweepMissingLegacyQuarantine(env: Env): Promise<void> {
  // Old acknowledgement deleted R2 before D1, so a failed D1 delete could
  // leave a bodyKey row with no object. An R2-driven scan cannot discover it;
  // rotate through a bounded D1 page and retire only confirmed-missing bodies.
  const cursorObject = await env.BODIES.get(LEGACY_RECOVERY_CURSOR_KEY);
  const cursor = cursorObject ? (await cursorObject.text()).trim() : "";
  const result = await env.INBOX
    .prepare(LEGACY_QUARANTINE_SQL)
    .bind(cursor, RECOVERY_SCAN_LIMIT)
    .all();
  const rows = (result.results ?? []) as Array<{
    id: string;
    payload: string;
    received_at: string;
  }>;
  let recovered = 0;
  let scanned = 0;
  let lastScanned: string | undefined;
  for (const row of rows) {
    const payload = parsePayload(row.payload) as Record<string, unknown>;
    const bodyKey = payload?.bodyKey;
    if (typeof bodyKey === "string" && !(await env.BODIES.head(bodyKey))) {
      if (recovered >= RECOVERY_PROMOTION_LIMIT) break;
      const tombstoneExists = Boolean(
        await env.BODIES.head(ackedEmailKey(row.id)),
      );
      await retireLegacyQuarantine(
        env,
        row.id,
        bodyKey,
        payload,
        row.received_at,
        true,
        tombstoneExists,
      );
      recovered += 1;
    }
    scanned += 1;
    lastScanned = row.id;
  }
  const moreRemain = scanned < rows.length || rows.length === RECOVERY_SCAN_LIMIT;
  if (moreRemain && lastScanned) {
    await env.BODIES.put(LEGACY_RECOVERY_CURSOR_KEY, lastScanned);
  } else {
    await env.BODIES.delete(LEGACY_RECOVERY_CURSOR_KEY);
  }
}

async function promotePendingEmails(env: Env): Promise<void> {
  const cursorObject = await env.BODIES.get(RECOVERY_CURSOR_KEY);
  const cursor = cursorObject ? (await cursorObject.text()).trim() : "";
  const listed = await env.BODIES.list({
    prefix: PENDING_EMAIL_PREFIX,
    limit: RECOVERY_SCAN_LIMIT,
    ...(cursor ? { cursor } : {}),
  });
  let recovered = 0;
  for (const object of listed.objects) {
    const id = pendingEmailId(object.key);
    if (!id) continue;

    // The common path is an email already represented in D1. Avoid pulling
    // its potentially multi-megabyte recovery record into Worker memory on
    // every drain.
    const indexed = await env.INBOX
      .prepare("SELECT id, payload, quarantined FROM inbox WHERE id = ?")
      .bind(id)
      .first() as { id: string; payload: string; quarantined: number } | null;
    if (indexed && !indexed.quarantined) continue;

    // Acks and promotion span two stores, so this small durable marker is
    // the ordering authority. It is intentionally retained: removing it
    // could let an in-flight promotion recreate the deleted D1 row.
    const tombstoneKey = ackedEmailKey(id);
    if (await env.BODIES.head(tombstoneKey)) {
      if (indexed?.quarantined) {
        if (recovered >= RECOVERY_PROMOTION_LIMIT) break;
        await retireLegacyQuarantine(
          env,
          id,
          object.key,
          parsePayload(indexed.payload),
          "",
          true,
          true,
        );
        recovered += 1;
      } else {
        await env.BODIES.delete(object.key);
      }
      continue;
    }

    if (recovered >= RECOVERY_PROMOTION_LIMIT) break;
    const stored = await env.BODIES.get(object.key);
    if (!stored) continue;
    const pending = JSON.parse(await stored.text()) as {
      row: {
        id: string;
        kind: "email";
        payload: Record<string, unknown>;
        receivedAt: string;
        quarantined: 0 | 1;
      };
    };
    const row = pending.row;
    if (row.id !== id) {
      throw new Error(`pending email id mismatch for ${object.key}`);
    }
    if (row.quarantined) {
      await retireLegacyQuarantine(
        env,
        id,
        object.key,
        row.payload,
        row.receivedAt,
        indexed !== null,
        false,
      );
      recovered += 1;
      continue;
    }
    // Close the race where ack starts while the pending object is being
    // downloaded. A retained tombstone remains authoritative thereafter.
    if (await env.BODIES.head(tombstoneKey)) continue;
    await env.INBOX
      .prepare(
        "INSERT OR IGNORE INTO inbox (id, kind, payload, received_at, quarantined) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        row.id,
        row.kind,
        JSON.stringify(row.payload),
        row.receivedAt,
        row.quarantined,
      )
      .run();
    recovered += 1;
    // If ack established its authority between the prior check and this
    // insert, retract the promoted row. If ack starts after this check, its
    // own D1 delete observes and removes the row instead.
    if (await env.BODIES.head(tombstoneKey)) {
      await env.INBOX.prepare("DELETE FROM inbox WHERE id = ?").bind(id).run();
    }
  }
  if (listed.truncated && listed.cursor) {
    await env.BODIES.put(RECOVERY_CURSOR_KEY, listed.cursor);
  } else {
    await env.BODIES.delete(RECOVERY_CURSOR_KEY);
  }
}

async function pruneMigratedQuarantine(db: D1Database): Promise<void> {
  await db
    .prepare(
      `DELETE FROM inbox
       WHERE quarantined = 1
         AND json_extract(payload, '$.bodyKey') IS NULL
         AND id NOT IN (
           SELECT id FROM inbox
           WHERE quarantined = 1
           ORDER BY id DESC
           LIMIT 50
      )`,
    )
    .bind()
    .run();
}

async function handleBody(id: string, env: Env): Promise<Response> {
  const row = (await env.INBOX
    .prepare("SELECT payload FROM inbox WHERE id = ? AND kind = 'email'")
    .bind(id)
    .first()) as { payload?: unknown } | null;
  if (!row || typeof row.payload !== "string") {
    return json({ error: "not found" }, 404);
  }
  const payload = parsePayload(row.payload) as Record<string, unknown>;
  if (typeof payload.bodyKey !== "string") {
    return json({ error: "body unavailable", detail: payload.error ?? null }, 404);
  }
  const object = await env.BODIES.get(payload.bodyKey);
  if (!object) return json({ error: "body object missing" }, 500);
  const pending = JSON.parse(await object.text()) as {
    body?: { text?: string; html?: string };
  };
  if (!pending.body) return json({ error: "body object invalid" }, 500);
  return new Response(JSON.stringify(pending.body), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

async function handleAck(request: Request, env: Env): Promise<Response> {
  const parsed = await readJson(request);
  const body = parsed === REQUEST_TOO_LARGE ? null : parsed;
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) {
    return json({ error: "ids must be an array of strings" }, 400);
  }
  let deleted = 0;
  for (let i = 0; i < ids.length; i += SQL_CHUNK) {
    const chunk = ids.slice(i, i + SQL_CHUNK) as string[];
    const placeholders = chunk.map(() => "?").join(",");
    await Promise.all(
      chunk.map((id) => env.BODIES.put(ackedEmailKey(id), "")),
    );
    const res = await env.INBOX
      .prepare(`DELETE FROM inbox WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .run();
    deleted += res.meta?.changes ?? 0;
    await env.BODIES.delete(chunk.map(pendingEmailKey));
  }
  return json({ deleted });
}

async function handleAllow(
  request: Request,
  env: Env,
): Promise<Response> {
  const parsed = await readJson(request);
  const body = parsed === REQUEST_TOO_LARGE ? null : parsed;
  const raw = body?.address;
  if (typeof raw !== "string" || raw.trim() === "") {
    return json({ error: "address required" }, 400);
  }
  const address = raw.trim().toLowerCase();
  // R2 is the independent fallback if D1 cannot answer during mail delivery.
  // Marker first: a partial allow can admit a verified sender, never lose one.
  await env.BODIES.put(allowedSenderKey(address), "");
  await env.INBOX
    .prepare(ALLOW_SENDER_SQL)
    .bind(address, new Date().toISOString())
    .run();

  // Match by parsed payload in JS so the un-quarantine is case-insensitive
  // and never trips on a malformed payload.
  const pending = await env.INBOX
    .prepare(QUARANTINED_EMAILS_SQL)
    .bind()
    .all();
  const ids: string[] = [];
  for (const rawRow of pending.results ?? []) {
    const row = rawRow as Record<string, unknown>;
    const payload = parsedPayload(row.payload as string);
    if (payload?.from?.toLowerCase() !== address) continue;
    if (payload.text !== undefined || payload.html !== undefined) {
      ids.push(row.id as string);
      continue;
    }
    if (!payload.bodyKey) continue;
    if (await env.BODIES.head(payload.bodyKey)) {
      ids.push(row.id as string);
      continue;
    }
    const id = row.id as string;
    await retireLegacyQuarantine(
      env,
      id,
      payload.bodyKey,
      payload,
      String(row.received_at ?? ""),
      true,
      Boolean(await env.BODIES.head(ackedEmailKey(id))),
    );
  }
  for (let i = 0; i < ids.length; i += SQL_CHUNK) {
    const chunk = ids.slice(i, i + SQL_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    await env.INBOX
      .prepare(`UPDATE inbox SET quarantined = 0 WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .run();
  }
  return json({ address, unquarantined: ids.length });
}

async function handleSyncSenders(env: Env): Promise<Response> {
  const result = await env.INBOX.prepare(LIST_SENDERS_SQL).bind().all();
  const addresses = (result.results ?? [])
    .map((row) => (row as Record<string, unknown>).address)
    .filter((address): address is string => typeof address === "string");
  await Promise.all(
    addresses.map((address) =>
      env.BODIES.put(allowedSenderKey(address.toLowerCase()), ""),
    ),
  );
  return json({ synced: addresses.length });
}

function parsedPayload(payload: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"
      ),
    );
  } catch {
    return null;
  }
}

export async function handleFetch(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/"))
    return json({ error: "not found" }, 404);
  const role = authorizationRole(request, env);
  if (!role)
    return json({ error: "unauthorized" }, 401);
  const captureRoute =
    request.method === "POST" &&
    ["/v1/save", "/v1/highlight", "/v1/capture"].includes(url.pathname);
  if (role === "capture" && !captureRoute) {
    return json({ error: "capture credential cannot access this route" }, 403);
  }
  if (request.method === "GET" && url.pathname.startsWith("/v1/body/")) {
    const id = decodeURIComponent(url.pathname.slice("/v1/body/".length));
    return handleBody(id, env);
  }
  switch (`${request.method} ${url.pathname}`) {
    case "POST /v1/capture": {
      const body = await readJson(request);
      if (body === REQUEST_TOO_LARGE) {
        return json({ error: "capture request is too large" }, 400);
      }
      const kind = body?.kind;
      if (kind !== "save" && kind !== "highlight" && kind !== "note") {
        return json({ error: "kind must be save, highlight, or note" }, 400);
      }
      return handleCapture(request, env.INBOX, kind, body);
    }
    case "POST /v1/save":
      return handleCapture(request, env.INBOX, "save");
    case "POST /v1/highlight":
      return handleCapture(request, env.INBOX, "highlight");
    case "GET /v1/drain":
      if (!url.searchParams.get("cursor")) {
        await sweepMissingLegacyQuarantine(env);
        await promotePendingEmails(env);
      }
      return handleDrain(url, env.INBOX);
    case "POST /v1/ack":
      return handleAck(request, env);
    case "POST /v1/allow":
      return handleAllow(request, env);
    case "POST /v1/sync-senders":
      return handleSyncSenders(env);
    default:
      return json({ error: "not found" }, 404);
  }
}

const worker = {
  fetch: (request: Request, env: Env) => handleFetch(request, env),
  email: (message: ForwardableEmailMessage, env: Env) =>
    handleEmail(
      message as unknown as InboundEmail,
      env.INBOX,
      env.BODIES,
    ),
};

export default worker;
