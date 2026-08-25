// Shared contract for all Wordhold components. Everything imports from here.
// Invariants these types encode are binding; see AGENTS.md.

export type SourceKind =
  | "shortcut" // share-sheet save Shortcut, via worker or iCloud file
  | "icloud_file" // capture file from the Shortcuts iCloud folder
  | "reading_list" // Safari Reading List ambient pull
  | "newsletter" // email-in via Cloudflare Email Routing
  | "highlight_share" // highlight Shortcut
  | "local_capture" // trusted local CLI/agent queue
  | "x_bookmark"; // adapter interface only in v1

export type ItemStatus =
  | "stub" // no URL (url-less manual highlight); exempt from fetch retry
  | "captured" // raw capture persisted, body not yet fetched; retry candidate
  | "fetch_failed" // bounded retries exhausted; excluded from enrichment
  | "has_body" // extraction succeeded, awaiting enrichment
  | "enriched"; // summary/tags/AI highlights present

export type HighlightOrigin = "manual" | "ai";

export type CaptureContextKind = "shared_text" | "note";

// User/app-supplied context is canonical but distinct from extracted article
// body and deliberate manual attention. It lives in item frontmatter and FTS.
export interface CaptureContext {
  id: string;
  kind: CaptureContextKind;
  source: SourceKind;
  text: string;
  capturedAt: string;
  identityHash?: string;
}

// A capture as it arrives from any source, before it becomes an item.
// Persist this (via store.ingestCapture) BEFORE attempting fetch/extraction.
export interface Capture {
  kind: "save" | "highlight" | "note" | "email";
  source: SourceKind;
  url?: string; // as received; store normalizes
  title?: string;
  text?: string; // highlight text, or email body for kind=email
  html?: string; // email html body when available
  emailFrom?: string; // sender address, kind=email only
  emailSubject?: string;
  capturedAt: string; // ISO 8601
  idempotencyKey?: string; // caller replay identity; may be shared across transports
  upstreamId?: string; // transport ack identity; raw-spooled but never canonical
}

export interface Item {
  id: string; // pt_<10 lowercase base36 chars>, minted once at creation
  url: string | null;
  urlHash: string | null; // sha256 hex of normalized url
  urlAliases: string[]; // prior/alternate normalized URLs that identify this item
  title: string | null;
  author: string | null;
  status: ItemStatus;
  fetchAttempts: number;
  lastError: string | null;
  sources: SourceKind[]; // union of every source that delivered this URL
  capturedAt: string;
  publishedAt: string | null;
  wordCount: number | null;
  summary: string | null;
  tags: string[];
  mdPath: string; // relative to repo root, items/YYYY/MM/<slug>-<id>.md
}

export interface Highlight {
  id: string; // hl_<10 lowercase base36 chars>, minted once at creation
  itemId: string;
  origin: HighlightOrigin;
  text: string;
  dedupeKey: string; // sha256 hex of itemId + "\n" + normalized text
  createdAt: string;
}

export interface SourceHealth {
  source: string; // adapter name, or "email:<sender>" per sender
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastNewItemAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

// Thrown by adapters on hard failures that need an immediate iMessage alert:
// auth walls, TCC permission errors, unreachable worker. NOT thrown for
// "no new items" or transient per-item failures.
export class AdapterHardError extends Error {
  constructor(
    public adapterName: string,
    message: string,
  ) {
    super(message);
    this.name = "AdapterHardError";
  }
}

export interface AdapterContext {
  repoRoot: string;
  config: WordholdConfig;
}

// Sources are isolated: main loop calls pull() per adapter, catches everything,
// records health. One adapter failing never blocks the others.
export interface SourceAdapter {
  name: string;
  // Setup/degraded state discovered without throwing (for example an absent
  // configured path). Main records this as non-healthy, never empty success.
  readonly note?: string;
  pull(ctx: AdapterContext): Promise<Capture[]>;
  // Called after captures are durably committed; adapters that must ack or
  // delete upstream state (worker inbox rows, iCloud files) do it here.
  ack?(ctx: AdapterContext, accepted: Capture[]): Promise<void>;
}

export interface WordholdConfig {
  // Absent only for pre-distribution installations, where legacy behavior is
  // preserved. Every new initializer writes all flags explicitly false.
  capabilities?: {
    workerInbox: boolean;
    icloudInbox: boolean;
    readingList: boolean;
    enrichment: boolean;
    digest: boolean;
    resurfacing: boolean;
  };
  worker: { baseUrl: string; secret: string };
  icloudInboxDir: string; // Shortcuts iCloud Documents folder
  readingListPlist: string; // ~/Library/Safari/Bookmarks.plist
  imessage: { recipient: string; dryRun: boolean };
  enrichment: { minBodyChars: number; maxFetchAttempts: number };
  // Private, ignored device handoff state. It records what the Mac offered and
  // verified; it never claims the external Shortcut was imported or changed.
  iphoneCapture?: {
    format: 1;
    inboxDir: string;
    offeredShortcut: { file: string; sha256: string };
    approvedShortcut?: { file: string; sha256: string };
    workerVerification?: {
      baseUrl: string;
      verifiedAt: string;
      credential: {
        kind: "keychain";
        account: string;
        service: string;
      };
    };
  };
  // Active online-only iPhone client state. This is separate from the legacy
  // iCloud handoff so installing or removing one cannot rewrite the other.
  iphoneOnline?: {
    format: 1;
    offeredShortcut: { file: string; sha256: string };
    approvedShortcut?: { file: string; sha256: string };
    workerVerification: {
      baseUrl: string;
      verifiedAt: string;
      credential: {
        kind: "keychain";
        account: string;
        service: string;
      };
    };
  };
}

export interface ResurfacingEvent {
  at: string; // ISO 8601
  highlightId: string;
  action: "shown" | "retired" | "unretired";
}

export interface ResurfacingState {
  highlightId: string;
  lastShownAt: string | null;
  timesShown: number;
  retired: boolean;
}
