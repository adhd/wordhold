// Inbound mail handling plus shared inbox-row primitives. Content failures are
// persisted rather than thrown. Authorization-store failure is the exception:
// accepting an indeterminate sender would either lose known mail or bypass the
// quarantine boundary, so the invocation fails visibly.

import PostalMime from "postal-mime";
import type { Email } from "postal-mime";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  canonicalIsoTimestamp,
  clipUtf8,
} from "../../core/capture-input.ts";

const MAX_ADDRESS_BYTES = 512;
const MAX_SUBJECT_BYTES = 8 * 1024;
const MAX_LIST_POST_BYTES = 8 * 1024;
const MAX_ERROR_BYTES = 1024;
const MAX_QUARANTINE_BODY_BYTES = 1024 * 1024;
const MAX_QUARANTINE_INLINE_BYTES = 32 * 1024;
const ALLOWED_SENDER_PREFIX = "sender-allowed/";

const INSERT_INBOX_SQL =
  "INSERT INTO inbox (id, kind, payload, received_at, quarantined) VALUES (?, ?, ?, ?, ?)";

let seq = 0;

// Time-prefixed so lexicographic id order matches arrival order; the drain
// cursor (WHERE id > ?) then pages oldest-first. The counter breaks same-ms
// ties within an isolate; the random suffix breaks them across isolates.
export function mintInboxId(): string {
  seq = (seq + 1) % 46656; // 36^3
  const t = Date.now().toString(36).padStart(9, "0");
  const c = seq.toString(36).padStart(3, "0");
  const rand = crypto.getRandomValues(new Uint8Array(4));
  let r = "";
  for (const b of rand) r += (b % 36).toString(36);
  return `in_${t}${c}${r}`;
}

export interface InboxRowInput {
  id: string;
  kind: "save" | "highlight" | "note" | "email";
  payload: Record<string, unknown>;
  receivedAt: string;
  quarantined: 0 | 1;
}

export async function insertInboxRow(
  db: D1Database,
  row: InboxRowInput,
  options: { ignoreExisting?: boolean } = {},
): Promise<void> {
  await db
    .prepare(
      options.ignoreExisting
        ? INSERT_INBOX_SQL.replace("INSERT INTO", "INSERT OR IGNORE INTO")
        : INSERT_INBOX_SQL,
    )
    .bind(
      row.id,
      row.kind,
      JSON.stringify(row.payload),
      row.receivedAt,
      row.quarantined,
    )
    .run();
}

export async function senderAllowed(
  db: D1Database,
  address: string,
): Promise<boolean> {
  if (!address) return false;
  const row = await db
    .prepare("SELECT address FROM senders WHERE address = ?")
    .bind(address.toLowerCase())
    .first();
  return row != null;
}

export function allowedSenderKey(address: string): string {
  return `${ALLOWED_SENDER_PREFIX}${encodeURIComponent(address.toLowerCase())}`;
}

async function senderAuthorized(
  db: D1Database,
  bodies: R2Bucket,
  address: string,
): Promise<boolean> {
  let d1Unavailable = false;
  try {
    if (await senderAllowed(db, address)) return true;
  } catch {
    d1Unavailable = true;
  }
  try {
    if (await bodies.head(allowedSenderKey(address))) return true;
  } catch {
    // Marker-first allow operations can leave R2 as the only evidence that a
    // sender was approved. A failed marker lookup is therefore indeterminate
    // even when D1 successfully reports no row.
    throw new Error("sender authorization unavailable");
  }
  if (d1Unavailable) throw new Error("sender authorization unavailable");
  return false;
}

// Structural subset of ForwardableEmailMessage so tests can hand in fakes.
export interface InboundEmail {
  from: string;
  headers: Headers;
  raw: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string;
}

export interface EmailDeps {
  parse?: (raw: InboundEmail["raw"]) => Promise<Email>;
  now?: () => string;
}

interface PendingEmail {
  row: InboxRowInput;
  body: { text: string; html?: string };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handleEmail(
  message: InboundEmail,
  db: D1Database,
  bodies: R2Bucket,
  deps: EmailDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => new Date().toISOString());
  const id = mintInboxId();
  const bodyKey = `email-pending/${id}.json`;
  const envelopeFrom = clipUtf8(
    (message.from ?? "").trim().toLowerCase(),
    MAX_ADDRESS_BYTES,
  );
  let headerFrom = envelopeFrom;
  let parsedSubject: string | null = headerSafe(message, "subject");
  let parsedDate: string | null = headerSafe(message, "date");
  let text = "";
  let html: string | undefined;
  let listPost: string | undefined;
  let parseError: string | undefined;
  const quarantined: 0 | 1 = (await senderAuthorized(
    db,
    bodies,
    envelopeFrom,
  ))
    ? 0
    : 1;
  let parseInput: InboundEmail["raw"] | null = message.raw;
  if (quarantined) {
    parseInput = await boundedRaw(message.raw, MAX_QUARANTINE_BODY_BYTES);
    if (parseInput === null) parseError = "quarantine_body_too_large";
  }
  if (parseInput !== null) {
    try {
      const parse =
        deps.parse ?? ((raw: InboundEmail["raw"]) => PostalMime.parse(raw));
      const parsed = await parse(parseInput);
      headerFrom = clipUtf8(
        (parsed.from?.address || envelopeFrom).trim().toLowerCase(),
        MAX_ADDRESS_BYTES,
      );
      parsedSubject = clipUtf8(parsed.subject ?? "", MAX_SUBJECT_BYTES);
      parsedDate = parsed.date ?? headerSafe(message, "date");
      text = parsed.text ?? "";
      html = parsed.html ?? undefined;
      const rawListPost = parsed.headers.find(
        (header) => header.key === "list-post",
      )?.value;
      listPost = rawListPost
        ? clipUtf8(rawListPost, MAX_LIST_POST_BYTES)
        : undefined;
    } catch (err) {
      parseError = clipUtf8(errorMessage(err), MAX_ERROR_BYTES);
    }
  }
  let receivedAt: string;
  try {
    receivedAt = canonicalIsoTimestamp(now());
  } catch {
    receivedAt = new Date().toISOString();
  }
  parsedSubject = parsedSubject
    ? clipUtf8(parsedSubject, MAX_SUBJECT_BYTES)
    : parsedSubject;
  parsedDate = canonicalEmailDate(parsedDate);
  const metadata: Record<string, unknown> = {
    from: envelopeFrom,
    ...(headerFrom && headerFrom !== envelopeFrom ? { headerFrom } : {}),
    subject: parsedSubject,
    date: parsedDate,
    ...(listPost ? { listPost } : {}),
    ...(parseError
      ? {
          error: parseError.startsWith("quarantine_")
            ? parseError
            : `parse_failed: ${parseError}`,
        }
      : {}),
  };
  if (quarantined) {
    const inlinePayload: Record<string, unknown> = {
      ...metadata,
      ...(parseInput !== null ? { text, ...(html ? { html } : {}) } : {}),
    };
    const payload =
      parseInput !== null &&
      new TextEncoder().encode(JSON.stringify(inlinePayload)).byteLength <=
        MAX_QUARANTINE_INLINE_BYTES
        ? inlinePayload
        : {
            ...metadata,
            error:
              parseInput === null
                ? "quarantine_body_too_large"
                : "quarantine_payload_too_large",
          };
    try {
      // Quarantine is single-store. The D1 trigger atomically retains only the
      // newest 50 rows, including under concurrent Worker invocations.
      await insertInboxRow(db, {
        id,
        kind: "email",
        payload,
        receivedAt,
        quarantined: 1,
      });
    } catch {
      // Unknown mail is not an accepted capture and must never create R2 orphans.
    }
    return;
  }

  const payload: Record<string, unknown> = { ...metadata, bodyKey };
  const row: InboxRowInput = {
    id,
    kind: "email",
    payload,
    receivedAt,
    quarantined,
  };
  const pending: PendingEmail = {
    row,
    // Attachments are deliberately dropped: never stored, never referenced.
    body: { text, ...(html ? { html } : {}) },
  };

  try {
    // Write-ahead: this self-contained R2 record exists before D1 membership.
    // A drain can promote it after an isolate death at any later boundary.
    await bodies.put(bodyKey, JSON.stringify(pending));
  } catch (bodyError) {
    // R2 itself failed. Best effort is a small D1 stub; never throw/bounce.
    delete payload.bodyKey;
    payload.error = `body_store_failed: ${errorMessage(bodyError)}`;
    try {
      await insertInboxRow(db, row);
    } catch {
      // Both independent stores failed. There is nowhere left to persist, but
      // propagating would bounce/suppress the sender, so the handler returns.
    }
    return;
  }
  try {
    await insertInboxRow(db, row);
  } catch {
    // The pending object is the durable queue record; drain will promote it.
  }
}

async function boundedRaw(
  raw: InboundEmail["raw"],
  maxBytes: number,
): Promise<InboundEmail["raw"] | null> {
  if (typeof raw === "string") {
    return new TextEncoder().encode(raw).byteLength <= maxBytes ? raw : null;
  }
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength <= maxBytes ? raw : null;
  }
  if (raw instanceof Uint8Array) {
    return raw.byteLength <= maxBytes ? raw : null;
  }
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
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
  return bytes;
}

function headerSafe(message: InboundEmail, key: string): string | null {
  try {
    return message.headers?.get(key) ?? null;
  } catch {
    return null;
  }
}

function canonicalEmailDate(value: string | null): string | null {
  if (!value) return null;
  const bounded = clipUtf8(value, 256);
  const parsed = Date.parse(bounded);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
