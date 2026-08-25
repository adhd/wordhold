import { safeWebUrl } from "./web-url.ts";

export interface SaveHighlightPayload {
  url?: string;
  title?: string;
  text?: string;
  capturedAt?: string;
}

const MAX_URL_BYTES = 8 * 1024;
const MAX_TITLE_BYTES = 2 * 1024;
const MAX_HIGHLIGHT_BYTES = 24 * 1024;
const MAX_TIMESTAMP_BYTES = 64;
export const MAX_IDEMPOTENCY_KEY_BYTES = 512;
export const MAX_CAPTURE_JSON_BYTES = 40 * 1024;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function clipUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(encoded.slice(0, maxBytes));
}

function bounded(value: string | undefined, field: string, maxBytes: number) {
  if (value !== undefined && utf8Length(value) > maxBytes) {
    throw new Error(`${field} exceeds ${maxBytes} bytes`);
  }
  return value;
}

export function canonicalIsoTimestamp(value: string): string {
  if (utf8Length(value) > MAX_TIMESTAMP_BYTES) {
    throw new Error(`timestamp exceeds ${MAX_TIMESTAMP_BYTES} bytes`);
  }
  const match = RFC3339.exec(value);
  if (!match) throw new Error("timestamp must be RFC 3339 date-time");
  const [, year, month, day, hour, minute, second, , zone] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const min = Number(minute);
  const sec = Number(second);
  const zoneHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > daysInMonth ||
    h > 23 ||
    min > 59 ||
    sec > 59 ||
    zoneHour > 23 ||
    zoneMinute > 59
  ) {
    throw new Error("timestamp contains an invalid date or time");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("timestamp is invalid");
  return new Date(parsed).toISOString();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

export function parseIdempotencyKey(value: unknown): string | undefined {
  const key = optionalString(value, "idempotencyKey");
  if (key === undefined) return undefined;
  if (!key.trim() || utf8Length(key) > MAX_IDEMPOTENCY_KEY_BYTES) {
    throw new Error(
      `idempotencyKey must be a non-empty string up to ${MAX_IDEMPOTENCY_KEY_BYTES} bytes`,
    );
  }
  return key;
}

// Runtime validation for untrusted Shortcut JSON. TypeScript interfaces alone
// do not protect files, HTTP bodies, or rows written by older deployments.
export function parseSaveHighlightPayload(
  kind: "save" | "highlight" | "note",
  value: unknown,
): SaveHighlightPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capture must be an object");
  }
  const input = value as Record<string, unknown>;
  const url = bounded(optionalString(input.url, "url")?.trim(), "url", MAX_URL_BYTES);
  const title = bounded(optionalString(input.title, "title"), "title", MAX_TITLE_BYTES);
  const text = bounded(optionalString(input.text, "text"), "text", MAX_HIGHLIGHT_BYTES);
  const capturedAt = optionalString(input.capturedAt, "capturedAt");
  if (kind === "save" && !url) throw new Error("save url required");
  if ((kind === "highlight" || kind === "note") && !text?.trim()) {
    throw new Error(`${kind} text required`);
  }
  const safeUrl = url ? safeWebUrl(url) : undefined;
  const canonicalCapturedAt = capturedAt
    ? canonicalIsoTimestamp(capturedAt)
    : undefined;
  return { url: safeUrl, title, text, capturedAt: canonicalCapturedAt };
}
