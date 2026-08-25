import {
  canonicalIsoTimestamp,
  parseIdempotencyKey,
  parseSaveHighlightPayload,
} from "./capture-input.ts";
import type { Capture, SourceKind } from "./types.ts";
import { safeWebUrl } from "./web-url.ts";

export interface CaptureRequest {
  input: string;
  intent?: "auto" | "save" | "highlight" | "note";
  url?: string;
  title?: string;
  capturedAt?: string;
  idempotencyKey?: string;
}

export function publicUrlsInText(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
  return [
    ...new Set(
      matches.map((match) =>
        safeWebUrl(match.replace(/[.,;:)}\]]+$/u, ""))
      ),
    ),
  ];
}

// Normalizes human/agent input before it reaches any transport. App-supplied
// text stays as context; finding a URL never silently turns that text into an
// extracted article body or a manual highlight.
export function normalizeCaptureRequest(
  request: CaptureRequest,
  source: SourceKind,
): Capture {
  if (typeof request.input !== "string") {
    throw new Error("capture input must be a string");
  }
  if (
    request.intent !== undefined &&
    !["auto", "save", "highlight", "note"].includes(request.intent)
  ) {
    throw new Error("intent must be auto, save, highlight, or note");
  }
  const idempotencyKey = parseIdempotencyKey(request.idempotencyKey);
  const input = request.input.trim();
  if (!input) throw new Error("capture input required");
  const capturedAt = request.capturedAt
    ? canonicalIsoTimestamp(request.capturedAt)
    : new Date().toISOString();
  if (request.intent === "highlight") {
    const parsed = parseSaveHighlightPayload("highlight", {
      url: request.url,
      title: request.title,
      text: input,
      capturedAt,
    });
    return {
      kind: "highlight",
      source,
      ...parsed,
      ...(idempotencyKey
        ? { idempotencyKey }
        : {}),
      capturedAt,
    };
  }
  const urls = publicUrlsInText(input);
  if (!request.url && urls.length > 1) {
    throw new Error(
      "capture input contains multiple URLs; choose one explicitly",
    );
  }
  const selectedUrl = request.url ?? urls[0];
  const kind = request.intent === "note" || (!selectedUrl && request.intent !== "save")
    ? "note"
    : "save";
  if (kind === "save") {
    const sharedText = input === selectedUrl ? undefined : input;
    const parsed = parseSaveHighlightPayload("save", {
      url: selectedUrl,
      title: request.title,
      text: sharedText,
      capturedAt,
    });
    return {
      kind,
      source,
      ...parsed,
      ...(idempotencyKey
        ? { idempotencyKey }
        : {}),
      capturedAt,
    };
  }
  const parsed = parseSaveHighlightPayload("highlight", {
    title: request.title,
    text: input,
    capturedAt,
  });
  return {
    kind,
    source,
    ...parsed,
    ...(idempotencyKey
      ? { idempotencyKey }
      : {}),
    capturedAt,
  };
}
