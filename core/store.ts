// Canonical write path. Every function writes the markdown file first, the db
// second: files are authoritative, the db is a rebuildable index (AGENTS.md).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Database } from "bun:sqlite";
import matter from "gray-matter";
import { atomicWriteFile } from "./atomic.ts";
import {
  insertHighlightRow,
  itemById,
  itemByUrlHash,
  syncItemFts,
  upsertItemRow,
} from "./db.ts";
import { mintCaptureContextId, mintHighlightId, mintItemId } from "./ids.ts";
import { applyJournalToDb } from "./journal.ts";
import type {
  Capture,
  CaptureContext,
  CaptureContextKind,
  Highlight,
  HighlightOrigin,
  Item,
  ItemStatus,
  SourceKind,
} from "./types.ts";
import {
  collapseWhitespace,
  highlightDedupeKey,
  newsletterPseudoUrl,
  normalizeUrl,
  slugify,
  urlHash,
} from "./urls.ts";
import { canonicalIsoTimestamp } from "./capture-input.ts";
import { claimWriterPath } from "./writer.ts";

export interface ItemFrontmatter {
  id: string;
  url: string | null;
  url_aliases: string[];
  dedupe_url?: string; // pseudo-url identity for canonical-URL-less emails
  title: string | null;
  author: string | null;
  sources: SourceKind[];
  status: ItemStatus;
  captured_at: string;
  published_at: string | null;
  tags: string[];
  summary: string | null;
  fetch_attempts: number;
  last_error: string | null;
  highlight_count: number;
  capture_contexts: Array<{
    id: string;
    kind: CaptureContextKind;
    source: SourceKind;
    text: string;
    captured_at: string;
    identity_hash?: string;
  }>;
}

export interface FileHighlight {
  id: string;
  origin: HighlightOrigin;
  text: string;
}

interface ItemFile {
  front: ItemFrontmatter;
  body: string;
  highlights: FileHighlight[];
  contexts: CaptureContext[];
}

const HL_LINE = /^- \[(manual|ai)\] <!-- (hl_[a-z0-9]{10}) --> (.*)$/;
const HL_MARKER = "\n## Highlights\n";

function countWords(s: string): number {
  return s ? s.split(/\s+/).filter(Boolean).length : 0;
}

function bodyHashOf(body: string): string | null {
  return body ? createHash("sha256").update(body).digest("hex") : null;
}

function assembleContent(body: string, highlights: FileHighlight[]): string {
  let content = "";
  if (body) content += "\n" + body + "\n";
  if (highlights.length) {
    content += HL_MARKER + "\n";
    content +=
      highlights
        .map((h) => `- [${h.origin}] <!-- ${h.id} --> ${h.text}`)
        .join("\n") + "\n";
  }
  return content || "\n";
}

function saveItemFile(repoRoot: string, mdPath: string, f: ItemFile): void {
  claimWriterPath(repoRoot, mdPath);
  const front: Record<string, unknown> = { id: f.front.id, url: f.front.url };
  front.url_aliases = f.front.url_aliases;
  if (f.front.dedupe_url !== undefined) front.dedupe_url = f.front.dedupe_url;
  front.title = f.front.title;
  front.author = f.front.author;
  front.sources = f.front.sources;
  front.status = f.front.status;
  front.captured_at = f.front.captured_at;
  front.published_at = f.front.published_at;
  front.tags = f.front.tags;
  front.summary = f.front.summary;
  front.fetch_attempts = f.front.fetch_attempts;
  front.last_error = f.front.last_error;
  front.capture_contexts = f.contexts.map((context) => ({
    id: context.id,
    kind: context.kind,
    source: context.source,
    text: context.text,
    captured_at: context.capturedAt,
    ...(context.identityHash ? { identity_hash: context.identityHash } : {}),
  }));
  // This explicit serializer-owned count disambiguates an article whose own
  // terminal text happens to look exactly like our human-readable section.
  front.highlight_count = f.highlights.length;
  const text = matter.stringify(assembleContent(f.body, f.highlights), front);
  const abs = join(repoRoot, mdPath);
  atomicWriteFile(abs, text);
}

function coerce(v: unknown): unknown {
  return v instanceof Date ? v.toISOString() : v;
}

function parseItemFile(raw: string): ItemFile {
  const parsed = matter(raw, {}); // options object opts out of gray-matter's shared cache
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) data[k] = coerce(v);
  const content = parsed.content;
  let body = content;
  let highlights: FileHighlight[] = [];
  const explicitHighlightCount =
    Number.isInteger(data.highlight_count) && Number(data.highlight_count) >= 0
      ? Number(data.highlight_count)
      : null;
  const idx = content.lastIndexOf(HL_MARKER);
  // Files written before highlight_count existed use the legacy structural
  // parse. Every current write adds the count, including zero, so source text
  // can no longer manufacture metadata merely by matching the marker syntax.
  if (idx !== -1 && explicitHighlightCount !== 0) {
    const lines = content
      .slice(idx + HL_MARKER.length)
      .split("\n")
      .filter((l) => l.trim() !== "");
    const parsedLines: FileHighlight[] = [];
    let ok = lines.length > 0;
    for (const line of lines) {
      const m = HL_LINE.exec(line);
      if (!m) {
        ok = false; // heading occurs inside body text, not a real section
        break;
      }
      parsedLines.push({
        origin: m[1] as HighlightOrigin,
        id: m[2],
        text: m[3],
      });
    }
    if (ok && explicitHighlightCount !== null) {
      ok = parsedLines.length === explicitHighlightCount;
      if (!ok) throw new Error("canonical highlight_count does not match section");
    }
    if (ok) {
      highlights = parsedLines;
      body = content.slice(0, idx);
    }
  } else if (explicitHighlightCount !== null && explicitHighlightCount > 0) {
    throw new Error("canonical highlight section missing");
  }
  const front: ItemFrontmatter = {
    id: String(data.id ?? ""),
    url: (data.url as string | null) ?? null,
    url_aliases: (data.url_aliases as string[]) ?? [],
    title: (data.title as string | null) ?? null,
    author: (data.author as string | null) ?? null,
    sources: (data.sources as SourceKind[]) ?? [],
    status: (data.status as ItemStatus) ?? "captured",
    captured_at: String(data.captured_at ?? ""),
    published_at: (data.published_at as string | null) ?? null,
    tags: (data.tags as string[]) ?? [],
    summary: (data.summary as string | null) ?? null,
    fetch_attempts: Number(data.fetch_attempts ?? 0),
    last_error: (data.last_error as string | null) ?? null,
    highlight_count: explicitHighlightCount ?? highlights.length,
    capture_contexts: [],
  };
  const rawContexts = Array.isArray(data.capture_contexts)
    ? data.capture_contexts
    : [];
  const contexts: CaptureContext[] = rawContexts.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("canonical capture_contexts entry must be an object");
    }
    const context = value as Record<string, unknown>;
    const kind = context.kind;
    if (kind !== "shared_text" && kind !== "note") {
      throw new Error("canonical capture context has invalid kind");
    }
    return {
      id: String(context.id ?? ""),
      kind,
      source: String(context.source ?? "") as SourceKind,
      text: String(context.text ?? ""),
      capturedAt: canonicalIsoTimestamp(String(context.captured_at ?? "")),
      ...(typeof context.identity_hash === "string"
        ? { identityHash: context.identity_hash }
        : {}),
    };
  });
  front.capture_contexts = contexts.map((context) => ({
    id: context.id,
    kind: context.kind,
    source: context.source,
    text: context.text,
    captured_at: context.capturedAt,
    ...(context.identityHash ? { identity_hash: context.identityHash } : {}),
  }));
  if (data.dedupe_url != null) front.dedupe_url = String(data.dedupe_url);
  return { front, body: body.trim(), highlights, contexts };
}

function loadItemFile(repoRoot: string, mdPath: string): ItemFile {
  return parseItemFile(readFileSync(join(repoRoot, mdPath), "utf8"));
}

export function readItem(
  repoRoot: string,
  mdPath: string,
): { frontmatter: ItemFrontmatter; body: string; highlights: FileHighlight[] } {
  const f = loadItemFile(repoRoot, mdPath);
  return { frontmatter: f.front, body: f.body, highlights: f.highlights };
}

// url wins over dedupe_url: once a canonical url is adopted it is the identity.
function itemFromFile(f: ItemFile, mdPath: string): Item {
  const identity = f.front.url ?? f.front.dedupe_url ?? null;
  return {
    id: f.front.id,
    url: f.front.url,
    urlHash: identity ? urlHash(identity) : null,
    urlAliases: f.front.url_aliases,
    title: f.front.title,
    author: f.front.author,
    status: f.front.status,
    fetchAttempts: f.front.fetch_attempts,
    lastError: f.front.last_error,
    sources: f.front.sources,
    capturedAt: f.front.captured_at,
    publishedAt: f.front.published_at,
    wordCount: f.body ? countWords(f.body) : null,
    summary: f.front.summary,
    tags: f.front.tags,
    mdPath,
  };
}

function syncFts(db: Database, item: Item, f: ItemFile): void {
  syncItemFts(
    db,
    item,
    f.body,
    f.highlights.map((h) => h.text),
    f.contexts.map((context) => context.text),
  );
}

function contextForCapture(capture: Capture): CaptureContext | null {
  const text = capture.text?.trim();
  if (!text || (capture.kind !== "save" && capture.kind !== "note")) {
    return null;
  }
  if (capture.kind === "save" && capture.url?.trim() === text) return null;
  return {
    id: mintCaptureContextId(),
    kind: capture.kind === "note" ? "note" : "shared_text",
    source: capture.source,
    text,
    capturedAt: capture.capturedAt,
    ...(capture.idempotencyKey
      ? {
          identityHash: createHash("sha256")
            .update(`${capture.source}\n${capture.idempotencyKey}`)
            .digest("hex"),
        }
      : {}),
  };
}

function sameContext(a: CaptureContext, b: CaptureContext): boolean {
  return (
    a.kind === b.kind &&
    a.source === b.source &&
    collapseWhitespace(a.text).toLowerCase() ===
      collapseWhitespace(b.text).toLowerCase()
  );
}

function sameNoteCapture(a: CaptureContext, b: CaptureContext): boolean {
  if (b.identityHash) return a.identityHash === b.identityHash;
  return (
    a.kind === b.kind &&
    a.source === b.source &&
    a.capturedAt === b.capturedAt &&
    collapseWhitespace(a.text).toLowerCase() ===
      collapseWhitespace(b.text).toLowerCase()
  );
}

function slugSourceFor(
  title: string | null,
  urlOrPseudo: string | null,
  text: string | null,
): string {
  if (title) return title;
  if (urlOrPseudo) {
    try {
      const u = new URL(urlOrPseudo);
      const path = u.pathname.replace(/\/+$/, "");
      if (path && path !== "/") return path;
      return u.hostname || urlOrPseudo;
    } catch {
      return urlOrPseudo;
    }
  }
  if (text) return text.slice(0, 60);
  return "item";
}

function mdPathFor(capturedAt: string, slugSource: string, id: string): string {
  const yyyy = capturedAt.slice(0, 4);
  const mm = capturedAt.slice(5, 7);
  const slug = slugify(slugSource, 60) || "item";
  return `items/${yyyy}/${mm}/${slug}-${id}.md`;
}

export interface IngestResult {
  item: Item;
  created: boolean;
  highlight?: Highlight;
}

export function ingestCapture(
  repoRoot: string,
  db: Database,
  capture: Capture,
): IngestResult {
  capture = {
    ...capture,
    capturedAt: canonicalIsoTimestamp(capture.capturedAt),
  };
  let rawUrl = capture.url?.trim() || undefined;
  let pseudo: string | undefined;
  if (rawUrl?.startsWith("newsletter://")) {
    pseudo = rawUrl;
    rawUrl = undefined;
  } else if (
    !rawUrl &&
    capture.kind === "email" &&
    capture.emailFrom &&
    capture.emailSubject
  ) {
    pseudo = newsletterPseudoUrl(
      capture.emailFrom.split("@").pop() ?? "unknown",
      capture.emailSubject,
      capture.idempotencyKey ?? capture.capturedAt,
    );
  }
  let normalized: string | null = null;
  if (rawUrl) {
    normalized = normalizeUrl(rawUrl);
  }
  const dedupeUrl = normalized ?? pseudo ?? null;
  const hash = dedupeUrl ? urlHash(dedupeUrl) : null;
  const hlText =
    capture.kind === "highlight" && capture.text
      ? collapseWhitespace(capture.text)
      : null;
  const title = capture.title?.trim() || capture.emailSubject?.trim() || null;
  const incomingContext = contextForCapture(capture);

  if (hash) {
    const existing = itemByUrlHash(db, hash);
    if (existing) {
      let item = existing;
      const needsSource = !existing.sources.includes(capture.source);
      const needsTitle = existing.title === null && title !== null;
      const f = loadItemFile(repoRoot, existing.mdPath);
      const needsContext = incomingContext !== null &&
        !f.contexts.some((context) => sameContext(context, incomingContext));
      if (needsSource || needsTitle || needsContext) {
        if (needsSource) f.front.sources = [...f.front.sources, capture.source];
        if (needsTitle) f.front.title = title;
        if (needsContext && incomingContext) f.contexts.push(incomingContext);
        saveItemFile(repoRoot, existing.mdPath, f);
        item = itemFromFile(f, existing.mdPath);
        upsertItemRow(db, item);
        if (needsTitle || needsContext) syncFts(db, item, f);
      }
      let highlight: Highlight | undefined;
      if (hlText) {
        highlight = appendHighlight(
          repoRoot,
          db,
          item.id,
          "manual",
          hlText,
          capture.capturedAt,
        ).highlight;
      }
      return { item, created: false, highlight };
    }
  } else if (incomingContext && capture.kind === "note") {
    // A note has no URL identity. Match its canonical text so a replay after
    // queue acknowledgement cannot mint another stub; retain a distinct
    // provenance entry when another entrance supplies the same note.
    const rows = db
      .query("SELECT id FROM items WHERE url_hash IS NULL ORDER BY captured_at, id")
      .all() as Array<{ id: string }>;
    for (const row of rows) {
      const item = itemById(db, row.id);
      if (!item) continue;
      const f = loadItemFile(repoRoot, item.mdPath);
      if (!f.contexts.some((context) => sameNoteCapture(context, incomingContext))) {
        continue;
      }
      const needsSource = !f.front.sources.includes(capture.source);
      const needsContext = !f.contexts.some((context) =>
        sameContext(context, incomingContext)
      );
      if (needsSource || needsContext) {
        if (needsSource) f.front.sources.push(capture.source);
        if (needsContext) f.contexts.push(incomingContext);
        saveItemFile(repoRoot, item.mdPath, f);
        const updated = itemFromFile(f, item.mdPath);
        upsertItemRow(db, updated);
        syncFts(db, updated, f);
        return { item: updated, created: false };
      }
      return { item, created: false };
    }
  } else if (hlText) {
    // url-less highlight replay must not spawn a second stub: dedupe on text
    const rows = db
      .query(
        `SELECT h.id, h.item_id, h.origin, h.text, h.dedupe_key, h.created_at
         FROM highlights h JOIN items i ON i.id = h.item_id
         WHERE i.url_hash IS NULL`,
      )
      .all() as {
      id: string;
      item_id: string;
      origin: HighlightOrigin;
      text: string;
      dedupe_key: string;
      created_at: string;
    }[];
    const norm = hlText.toLowerCase();
    for (const r of rows) {
      if (collapseWhitespace(r.text).toLowerCase() === norm) {
        const item = itemById(db, r.item_id);
        if (item) {
          return {
            item,
            created: false,
            highlight: {
              id: r.id,
              itemId: r.item_id,
              origin: r.origin,
              text: r.text,
              dedupeKey: r.dedupe_key,
              createdAt: r.created_at,
            },
          };
        }
      }
    }
  }

  const id = mintItemId();
  const status: ItemStatus = dedupeUrl ? "captured" : "stub";
  const mdPath = mdPathFor(
    capture.capturedAt,
    slugSourceFor(title, normalized ?? pseudo ?? null, hlText),
    id,
  );
  const front: ItemFrontmatter = {
    id,
    url: normalized,
    url_aliases: [],
    title,
    author: null,
    sources: [capture.source],
    status,
    captured_at: capture.capturedAt,
    published_at: null,
    tags: [],
    summary: null,
    fetch_attempts: 0,
    last_error: null,
    highlight_count: 0,
    capture_contexts: [],
  };
  if (pseudo) front.dedupe_url = pseudo;
  let highlight: Highlight | undefined;
  const highlights: FileHighlight[] = [];
  if (hlText) {
    highlight = {
      id: mintHighlightId(),
      itemId: id,
      origin: "manual",
      text: hlText,
      dedupeKey: highlightDedupeKey(id, hlText),
      createdAt: capture.capturedAt,
    };
    highlights.push({ id: highlight.id, origin: "manual", text: hlText });
  }
  const f: ItemFile = {
    front,
    body: "",
    highlights,
    contexts: incomingContext ? [incomingContext] : [],
  };
  saveItemFile(repoRoot, mdPath, f);
  const item = itemFromFile(f, mdPath);
  const hl = highlight;
  db.transaction(() => {
    upsertItemRow(db, item);
    if (hl) insertHighlightRow(db, hl);
    syncFts(db, item, f);
  })();
  return { item, created: true, highlight };
}

export function appendHighlight(
  repoRoot: string,
  db: Database,
  itemId: string,
  origin: HighlightOrigin,
  text: string,
  createdAt: string,
): { highlight: Highlight; inserted: boolean } {
  const item = itemById(db, itemId);
  if (!item) throw new Error(`appendHighlight: unknown item ${itemId}`);
  const norm = collapseWhitespace(text);
  if (!norm) throw new Error("appendHighlight: empty highlight text");
  const key = highlightDedupeKey(itemId, norm);
  const f = loadItemFile(repoRoot, item.mdPath);
  const existingIndex = f.highlights.findIndex(
    (h) => highlightDedupeKey(itemId, h.text) === key,
  );
  if (existingIndex !== -1) {
    let existing = f.highlights[existingIndex]!;
    if (origin === "manual" && existing.origin === "ai") {
      // Manual attention is stronger provenance than an earlier AI proposal.
      // Promote the existing stable id rather than minting a duplicate.
      existing = { ...existing, origin: "manual" };
      f.highlights[existingIndex] = existing;
      saveItemFile(repoRoot, item.mdPath, f);
      db.run("UPDATE highlights SET origin = 'manual' WHERE id = ?", [
        existing.id,
      ]);
    }
    const hl: Highlight = {
      id: existing.id,
      itemId,
      origin: existing.origin,
      text: existing.text,
      dedupeKey: key,
      createdAt,
    };
    insertHighlightRow(db, hl); // heals the row if a crash lost the db write
    return { highlight: hl, inserted: false };
  }
  const hl: Highlight = {
    id: mintHighlightId(),
    itemId,
    origin,
    text: norm,
    dedupeKey: key,
    createdAt,
  };
  f.highlights.push({ id: hl.id, origin, text: norm });
  saveItemFile(repoRoot, item.mdPath, f);
  const inserted = insertHighlightRow(db, hl);
  syncFts(db, item, f);
  return { highlight: hl, inserted };
}

export type FetchResult =
  | {
      bodyMd: string;
      title?: string;
      author?: string;
      publishedAt?: string;
      wordCount?: number; // advisory; word_count is recomputed from bodyMd so rebuild agrees
      canonicalUrl?: string;
    }
  | { error: string; transient: boolean };

export interface FetchRecordDeps {
  // Fault-injection seam for the crash-recovery contract.
  afterMergeWinnerWrite?: () => void;
}

export function recordFetchResult(
  repoRoot: string,
  db: Database,
  itemId: string,
  result: FetchResult,
  maxAttempts: number,
  deps: FetchRecordDeps = {},
): Item {
  let item = itemById(db, itemId);
  if (!item) throw new Error(`recordFetchResult: unknown item ${itemId}`);

  if ("error" in result) {
    const f = loadItemFile(repoRoot, item.mdPath);
    f.front.fetch_attempts += 1;
    f.front.last_error = result.error;
    if (f.front.status === "captured" || f.front.status === "fetch_failed") {
      f.front.status =
        !result.transient || f.front.fetch_attempts >= maxAttempts
          ? "fetch_failed"
          : "captured";
    }
    saveItemFile(repoRoot, item.mdPath, f);
    const updated = itemFromFile(f, item.mdPath);
    upsertItemRow(db, updated);
    return updated;
  }

  let f = loadItemFile(repoRoot, item.mdPath);
  if (f.body) return item; // a non-empty body is immutable
  const body = result.bodyMd.trim();
  if (!body)
    throw new Error(
      `recordFetchResult: empty bodyMd for ${itemId}; report a failure instead`,
    );

  let canonical: string | null = null;
  if (result.canonicalUrl) {
    try {
      canonical = normalizeUrl(result.canonicalUrl);
    } catch {
      canonical = null;
    }
  }
  if (canonical && urlHash(canonical) !== item.urlHash) {
    const other = itemByUrlHash(db, urlHash(canonical));
    if (other && other.id !== item.id) {
      item = mergeItems(repoRoot, db, item, other, canonical, deps);
      f = loadItemFile(repoRoot, item.mdPath);
      if (f.body) return item; // merge brought a body along; keep it
    }
  }

  if (canonical && f.front.url && canonical !== f.front.url) {
    if (!f.front.url_aliases.includes(f.front.url)) {
      f.front.url_aliases.push(f.front.url);
    }
  }
  f.front.url = canonical ?? f.front.url;
  if (result.title !== undefined) f.front.title = result.title;
  if (result.author !== undefined) f.front.author = result.author;
  if (result.publishedAt !== undefined)
    f.front.published_at = result.publishedAt;
  f.body = body;
  f.front.status = "has_body";
  f.front.last_error = null;
  saveItemFile(repoRoot, item.mdPath, f);
  const updated = itemFromFile(f, item.mdPath);
  db.transaction(() => {
    upsertItemRow(db, updated, bodyHashOf(body));
    syncFts(db, updated, f);
  })();
  return updated;
}

// Union sources and highlights into the older item; delete the newer one.
// Moved highlights keep their ids; for same text, manual provenance/id wins AI.
function mergeItems(
  repoRoot: string,
  db: Database,
  a: Item,
  b: Item,
  canonical: string,
  deps: FetchRecordDeps,
): Item {
  const aOlder =
    a.capturedAt < b.capturedAt ||
    (a.capturedAt === b.capturedAt && a.id <= b.id);
  const [winner, loser] = aOlder ? [a, b] : [b, a];
  const intent: MergeIntent = {
    winnerPath: winner.mdPath,
    loserPath: loser.mdPath,
    canonical,
  };
  const path = mergeIntentPath(repoRoot, winner.id, loser.id);
  atomicWriteFile(path, JSON.stringify(intent) + "\n");
  completeMergeIntent(repoRoot, path, intent, deps.afterMergeWinnerWrite);
  // Merges are rare. Rebuilding the disposable index is simpler and safer
  // than trying to mirror a multi-file transaction in SQLite.
  rebuild(repoRoot, db);
  const updated = itemById(db, winner.id);
  if (!updated) throw new Error(`merge recovery lost winner ${winner.id}`);
  return updated;
}

interface MergeIntent {
  winnerPath: string;
  loserPath: string;
  canonical: string;
}

function mergeIntentPath(
  repoRoot: string,
  winnerId: string,
  loserId: string,
): string {
  return join(repoRoot, "inbox", "merges", `${winnerId}-${loserId}.json`);
}

function validItemPath(path: string): boolean {
  return (
    !isAbsolute(path) &&
    path.startsWith("items/") &&
    !path.split("/").includes("..") &&
    path.endsWith(".md")
  );
}

function mergeFileData(
  wf: ItemFile,
  lf: ItemFile,
  winnerId: string,
  canonical: string,
): void {
  for (const s of lf.front.sources) {
    if (!wf.front.sources.includes(s)) wf.front.sources.push(s);
  }
  wf.front.url = canonical;
  for (const alias of [
    ...wf.front.url_aliases,
    ...lf.front.url_aliases,
    ...(lf.front.url ? [lf.front.url] : []),
  ]) {
    if (alias !== canonical && !wf.front.url_aliases.includes(alias)) {
      wf.front.url_aliases.push(alias);
    }
  }
  wf.front.title ??= lf.front.title;
  wf.front.author ??= lf.front.author;
  wf.front.published_at ??= lf.front.published_at;
  if (!wf.body && lf.body) {
    wf.body = lf.body;
    wf.front.status = lf.front.status === "enriched" ? "enriched" : "has_body";
    wf.front.summary ??= lf.front.summary;
    if (wf.front.tags.length === 0) wf.front.tags = lf.front.tags;
  }
  const winnerKeys = new Map(
    wf.highlights.map((h, index) => [
      highlightDedupeKey(winnerId, h.text),
      index,
    ]),
  );
  for (const h of lf.highlights) {
    const key = highlightDedupeKey(winnerId, h.text);
    const existingIndex = winnerKeys.get(key);
    if (existingIndex !== undefined) {
      const existing = wf.highlights[existingIndex]!;
      if (existing.origin === "ai" && h.origin === "manual") {
        wf.highlights[existingIndex] = h;
      }
      continue;
    }
    winnerKeys.set(key, wf.highlights.length);
    wf.highlights.push(h);
  }
  for (const context of lf.contexts) {
    if (!wf.contexts.some((existing) => sameContext(existing, context))) {
      wf.contexts.push(context);
    }
  }
}

function completeMergeIntent(
  repoRoot: string,
  intentPath: string,
  intent: MergeIntent,
  afterWinnerWrite?: () => void,
): void {
  if (!validItemPath(intent.winnerPath) || !validItemPath(intent.loserPath)) {
    throw new Error(`unsafe merge intent ${intentPath}`);
  }
  const winnerAbs = join(repoRoot, intent.winnerPath);
  const loserAbs = join(repoRoot, intent.loserPath);
  if (!existsSync(winnerAbs)) {
    throw new Error(`merge winner missing for ${intentPath}`);
  }
  if (existsSync(loserAbs)) {
    const wf = loadItemFile(repoRoot, intent.winnerPath);
    const lf = loadItemFile(repoRoot, intent.loserPath);
    mergeFileData(wf, lf, wf.front.id, intent.canonical);
    saveItemFile(repoRoot, intent.winnerPath, wf);
    afterWinnerWrite?.();
    claimWriterPath(repoRoot, intent.loserPath);
    unlinkSync(loserAbs);
  }
  if (existsSync(intentPath)) unlinkSync(intentPath);
}

export function recoverPendingMerges(repoRoot: string): void {
  const paths = [
    ...new Bun.Glob("inbox/merges/*.json").scanSync({ cwd: repoRoot }),
  ].sort();
  for (const relative of paths) {
    const path = join(repoRoot, relative);
    let intent: MergeIntent;
    try {
      intent = JSON.parse(readFileSync(path, "utf8")) as MergeIntent;
    } catch {
      throw new Error(`invalid merge intent ${relative}`);
    }
    completeMergeIntent(repoRoot, path, intent);
  }
}

export function setEnrichment(
  repoRoot: string,
  db: Database,
  itemId: string,
  enrichment: { summary: string; tags: string[]; aiHighlights: string[] },
): Item {
  const item = itemById(db, itemId);
  if (!item) throw new Error(`setEnrichment: unknown item ${itemId}`);
  const f = loadItemFile(repoRoot, item.mdPath);
  if (
    !f.body ||
    f.front.status === "stub" ||
    f.front.status === "captured" ||
    f.front.status === "fetch_failed"
  ) {
    throw new Error(
      `setEnrichment: refusing to enrich ${itemId} (status ${f.front.status}, body ${f.body ? "present" : "absent"})`,
    );
  }
  const at = new Date().toISOString();
  const existingKeys = new Set(
    f.highlights.map((h) => highlightDedupeKey(itemId, h.text)),
  );
  const added: Highlight[] = [];
  for (const text of enrichment.aiHighlights) {
    const normalized = collapseWhitespace(text);
    if (!normalized) continue;
    const dedupeKey = highlightDedupeKey(itemId, normalized);
    if (existingKeys.has(dedupeKey)) continue;
    existingKeys.add(dedupeKey);
    const highlight: Highlight = {
      id: mintHighlightId(),
      itemId,
      origin: "ai",
      text: normalized,
      dedupeKey,
      createdAt: at,
    };
    added.push(highlight);
    f.highlights.push({
      id: highlight.id,
      origin: highlight.origin,
      text: highlight.text,
    });
  }
  f.front.summary = enrichment.summary;
  f.front.tags = enrichment.tags;
  f.front.status = "enriched";
  f.front.last_error = null;
  // Summary, tags, status, and the complete AI-highlight set become visible in
  // one atomic canonical-file replacement. A crash can leave the DB behind,
  // but rebuild heals derived state from this complete file.
  saveItemFile(repoRoot, item.mdPath, f);
  const updated = itemFromFile(f, item.mdPath);
  db.transaction(() => {
    upsertItemRow(db, updated, bodyHashOf(f.body));
    for (const highlight of added) insertHighlightRow(db, highlight);
    syncFts(db, updated, f);
  })();
  return itemById(db, itemId)!;
}

export function rebuild(repoRoot: string, db: Database): void {
  recoverPendingMerges(repoRoot);
  const paths = [
    ...new Bun.Glob("items/**/*.md").scanSync({ cwd: repoRoot }),
  ].sort();
  // Clearing and repopulating are one visibility boundary. If any canonical
  // file cannot be parsed, SQLite rolls back to the previous complete index;
  // readers may keep using that explicitly degraded last-good projection.
  db.transaction(() => {
    db.exec(
      "DELETE FROM resurfacing_state; DELETE FROM highlights; DELETE FROM item_url_aliases; DELETE FROM items; DELETE FROM items_fts;",
    );
    for (const mdPath of paths) {
      let f: ItemFile;
      try {
        f = loadItemFile(repoRoot, mdPath);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid canonical file ${mdPath}: ${reason}`);
      }
      if (!f.front.id) continue;
      const item = itemFromFile(f, mdPath);
      upsertItemRow(db, item, f.body ? bodyHashOf(f.body) : null);
      for (const h of f.highlights) {
        insertHighlightRow(db, {
          id: h.id,
          itemId: item.id,
          origin: h.origin,
          text: h.text,
          dedupeKey: highlightDedupeKey(item.id, h.text),
          createdAt: f.front.captured_at, // append time is not stored in the file
        });
      }
      syncFts(db, item, f);
    }
    applyJournalToDb(repoRoot, db);
  })();
}
