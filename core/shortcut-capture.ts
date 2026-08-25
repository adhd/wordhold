import {
  canonicalIsoTimestamp,
  MAX_CAPTURE_JSON_BYTES,
  parseIdempotencyKey,
  parseSaveHighlightPayload,
  utf8Length,
} from "./capture-input.ts";

export interface ShortcutShareInput {
  urls?: string[];
  sharedText?: string;
  selectedText?: string;
  pageUrl?: string;
  pageTitle?: string;
  capturedAt: string;
  idempotencyKey: string;
  choice?:
    | { kind: "url"; url: string }
    | { kind: "highlight"; url: string }
    | { kind: "note" };
}

export interface ShortcutCapturePayload {
  kind: "save" | "highlight" | "note";
  url?: string;
  title?: string;
  text?: string;
  capturedAt: string;
  idempotencyKey: string;
}

export interface ShortcutDeliveryResult {
  status: "queued" | "accepted" | "failed";
  local: "queued" | "failed";
  remote: "disabled" | "accepted" | "unavailable" | "rejected" | "not_attempted";
  message: string;
}

function validateChoice(value: unknown): ShortcutShareInput["choice"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("choice must be note, url, or highlight");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (record.kind === "note" && keys === "kind") return { kind: "note" };
  if (
    (record.kind === "url" || record.kind === "highlight") &&
    keys === "kind,url" &&
    typeof record.url === "string" &&
    record.url.trim() !== ""
  ) {
    return { kind: record.kind, url: record.url.trim() };
  }
  throw new Error("choice must be note, url, or highlight");
}

/** Executable specification for the decisions implemented by the Shortcut. */
export function normalizeShortcutShare(
  input: ShortcutShareInput,
): ShortcutCapturePayload {
  const choice = validateChoice(input.choice);
  const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
  if (!idempotencyKey) throw new Error("idempotency key required");
  const urls = [...new Set(
    [input.pageUrl, ...(input.urls ?? [])]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean),
  )];
  const isAutomaticHighlight = !choice && Boolean(input.selectedText && input.pageUrl);
  if (!isAutomaticHighlight && urls.length > 1 && !choice) {
    throw new Error("choose one URL or save as note");
  }
  if (
    (choice?.kind === "url" || choice?.kind === "highlight") &&
    !urls.includes(choice.url)
  ) {
    throw new Error("chosen URL was not present in the share");
  }
  const chosenUrl = choice?.kind === "url" || choice?.kind === "highlight"
    ? choice.url
    : urls[0];
  const kind = choice?.kind === "highlight"
    ? "highlight"
    : choice?.kind === "note"
    ? "note"
    : choice?.kind === "url"
    ? "save"
    : isAutomaticHighlight
    ? "highlight"
    : chosenUrl
    ? "save"
    : "note";
  const payload = parseSaveHighlightPayload(kind, {
    url: kind === "note" ? undefined : chosenUrl,
    title: input.pageTitle,
    text: kind === "highlight"
      ? input.selectedText ?? input.sharedText
      : kind === "note"
      ? input.selectedText ?? input.sharedText
      : input.sharedText,
    capturedAt: input.capturedAt,
  });
  const normalized: ShortcutCapturePayload = {
    kind,
    ...payload,
    capturedAt: canonicalIsoTimestamp(input.capturedAt),
    idempotencyKey,
  };
  if (utf8Length(JSON.stringify(normalized)) > MAX_CAPTURE_JSON_BYTES) {
    throw new Error(`serialized capture exceeds ${MAX_CAPTURE_JSON_BYTES} bytes`);
  }
  return normalized;
}

/**
 * Executable ordering contract for the Shortcut: durable local write always
 * precedes the optional network acceleration, and local durability determines
 * whether the gesture may report success.
 */
export async function deliverShortcutCapture(
  payload: ShortcutCapturePayload,
  deps: {
    writeLocal: (payload: ShortcutCapturePayload) => Promise<unknown>;
    sendWorker?: (payload: ShortcutCapturePayload) => Promise<"accepted" | "rejected">;
  },
): Promise<ShortcutDeliveryResult> {
  try {
    await deps.writeLocal(payload);
  } catch {
    return {
      status: "failed",
      local: "failed",
      remote: "not_attempted",
      message: "Wordhold could not queue this capture.",
    };
  }
  if (!deps.sendWorker) {
    return {
      status: "queued",
      local: "queued",
      remote: "disabled",
      message: "Queued for Wordhold validation.",
    };
  }
  try {
    const remote = await deps.sendWorker(payload);
    return remote === "accepted"
      ? {
        status: "accepted",
        local: "queued",
        remote,
        message: "Accepted by Wordhold.",
      }
      : {
        status: "queued",
        local: "queued",
        remote,
        message: "Queued for Wordhold validation; Worker needs attention.",
      };
  } catch {
    return {
      status: "queued",
      local: "queued",
      remote: "unavailable",
      message: "Queued for Wordhold validation; Worker unavailable.",
    };
  }
}
