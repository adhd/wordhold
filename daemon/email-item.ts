// Newsletter email -> item conversion. Pure functions: no fs, no network
// (resolveTrackingLinks talks only to its injected fetchFn).

import { parseHTML } from "linkedom";
import { publicUrlsInText } from "../core/capture-request.ts";
import type { Capture } from "../core/types.ts";
import {
  newsletterPseudoUrl,
  safeResolvedWebUrl,
  safeWebUrl,
  type HostResolver,
} from "../core/urls.ts";

interface TurndownLike {
  turndown(html: string): string;
  remove(filter: string | string[]): TurndownLike;
}
// turndown ships no type declarations; loaded via require, typed structurally
const TurndownService = require("turndown") as new (
  options?: Record<string, unknown>,
) => TurndownLike;

export interface EmailItemInput {
  url: string | null;
  pseudoUrl: string | null; // set iff url is null; dedupe identity, never the item url
  title: string | null;
  bodyMd: string;
  senderDomain: string;
  sender: string;
  mode: "article" | "link_share" | "plain_text";
  contextText: string | null;
}

const SUBJECT_PREFIXES = /^(?:\s*(?:fwd?|re)\s*:\s*)+/i;
const VIEW_IN_BROWSER =
  /\bview(?:\s+this)?(?:\s+(?:post|email|issue))?(?:\s+(?:in|on))?(?:\s+(?:your|the))?\s+(?:browser|web)\b/i;

type Doc = ReturnType<typeof parseHTML>["document"];

export function emailCaptureToItemInput(capture: Capture): EmailItemInput {
  const { sender, senderDomain } = parseSender(capture.emailFrom);
  const rawSubject = capture.emailSubject ?? capture.title ?? "";
  const strippedSubject = rawSubject.replace(SUBJECT_PREFIXES, "").trim();
  const title = strippedSubject || null;

  let url = urlFromListPost(capture.url);
  let hasCanonicalSignal = url !== null;
  let bodyMd = "";
  if (capture.html && capture.html.trim()) {
    const { document } = parseHTML(capture.html);
    if (!url) {
      url = canonicalUrl(document) ?? viewInBrowserUrl(document);
      hasCanonicalSignal = url !== null;
    }
    bodyMd = documentToMarkdown(document);
  }
  if (!bodyMd) bodyMd = capture.text ?? "";

  let mode: EmailItemInput["mode"] = "article";
  let contextText: string | null = null;
  if (!hasCanonicalSignal && !url) {
    const candidates = publicUrlsInText(bodyMd).filter(
      (candidate) => !isTrackingHost(candidate),
    );
    if (candidates.length === 1) {
      url = candidates[0]!;
      mode = "link_share";
      contextText = bodyMd;
      bodyMd = "";
    } else if (!capture.html?.trim() && bodyMd.trim()) {
      mode = "plain_text";
      contextText = bodyMd;
    }
  }

  const pseudoUrl = url
    ? null
    : newsletterPseudoUrl(
        senderDomain,
        strippedSubject || rawSubject,
        capture.idempotencyKey ?? capture.capturedAt,
      );
  return {
    url,
    pseudoUrl,
    title,
    bodyMd,
    senderDomain,
    sender,
    mode,
    contextText,
  };
}

function parseSender(from?: string): { sender: string; senderDomain: string } {
  const raw = (from ?? "").trim();
  const addr =
    /<([^<>\s]+@[^<>\s]+)>/.exec(raw)?.[1] ??
    /([^\s<>,;"]+@[^\s<>,;"]+)/.exec(raw)?.[1] ??
    raw;
  const sender = addr.toLowerCase();
  const at = sender.lastIndexOf("@");
  const senderDomain =
    at > 0 ? sender.slice(at + 1).replace(/\.$/, "") : "unknown";
  return { sender, senderDomain };
}

function asHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    return safeWebUrl(s);
  } catch {
    return null;
  }
}

// List-Post is often "<https://...>, <mailto:...>"; only http(s) entries count.
function urlFromListPost(raw?: string): string | null {
  if (!raw) return null;
  const bracketed = raw.match(/<[^<>]+>/g);
  const candidates = bracketed
    ? bracketed.map((s) => s.slice(1, -1))
    : raw.split(",");
  for (const c of candidates) {
    const u = asHttpUrl(c);
    if (u) return u;
  }
  return null;
}

function canonicalUrl(document: Doc): string | null {
  for (const link of document.querySelectorAll("link[rel]")) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase();
    if (!rel.split(/\s+/).includes("canonical")) continue;
    const u = asHttpUrl(link.getAttribute("href"));
    if (u) return u;
  }
  const og = document.querySelector(
    'meta[property="og:url"], meta[name="og:url"]',
  );
  return asHttpUrl(og?.getAttribute("content"));
}

function viewInBrowserUrl(document: Doc): string | null {
  for (const a of document.querySelectorAll("a[href]")) {
    const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!VIEW_IN_BROWSER.test(text)) continue;
    const u = asHttpUrl(a.getAttribute("href"));
    if (u) return u;
  }
  return null;
}

let tdService: TurndownLike | null = null;

function documentToMarkdown(document: Doc): string {
  for (const n of [
    ...document.querySelectorAll("script,style,link,meta,title,head"),
  ]) {
    n.remove();
  }
  for (const img of [...document.querySelectorAll("img")]) {
    if (isTrackingPixel(img)) img.remove();
  }
  unwrapTrivialTables(document);
  // Fragments parse with an empty body and content loose on the document.
  const body = document.body;
  const html =
    body && body.childNodes.length > 0 ? body.innerHTML : document.toString();
  tdService ??= new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    hr: "---",
    bulletListMarker: "-",
  }).remove(["script", "style", "title"]);
  return tdService
    .turndown(html)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isTrackingPixel(img: Element): boolean {
  const attrDim = (v: string | null): number | null => {
    const m = v == null ? null : /^\s*(\d+(?:\.\d+)?)/.exec(v);
    return m ? Number(m[1]) : null;
  };
  let w = attrDim(img.getAttribute("width"));
  let h = attrDim(img.getAttribute("height"));
  const style = img.getAttribute("style") ?? "";
  const sw = /(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)px/i.exec(style);
  const sh = /(?:^|;)\s*height\s*:\s*(\d+(?:\.\d+)?)px/i.exec(style);
  if (sw) w = Number(sw[1]);
  if (sh) h = Number(sh[1]);
  return w != null && h != null && w <= 1 && h <= 1;
}

// Layout tables where every own row has at most one cell (classic email
// single-column nesting) get replaced by their cell contents. Data-shaped
// tables (multiple cells per row, or any th) are left alone.
function unwrapTrivialTables(document: Doc): void {
  let guard = 100;
  while (guard-- > 0) {
    const tables = [...document.querySelectorAll("table")];
    const target = tables.find((t) => isTrivialLayoutTable(t));
    if (!target) return;
    unwrapTable(document, target);
  }
}

function ownRows(table: Element): Element[] {
  return [...table.querySelectorAll("tr")].filter(
    (tr) => tr.closest("table") === table,
  );
}

function ownCells(tr: Element): Element[] {
  return [...tr.querySelectorAll("td,th")].filter(
    (c) => c.closest("tr") === tr,
  );
}

function isTrivialLayoutTable(table: Element): boolean {
  for (const tr of ownRows(table)) {
    const cells = ownCells(tr);
    if (cells.length > 1) return false;
    if (cells.some((c) => c.tagName === "TH")) return false;
  }
  return true;
}

function unwrapTable(document: Doc, table: Element): void {
  const replacement = document.createElement("div");
  for (const tr of ownRows(table)) {
    for (const cell of ownCells(tr)) {
      const block = document.createElement("div");
      while (cell.firstChild) block.appendChild(cell.firstChild);
      replacement.appendChild(block);
    }
  }
  table.replaceWith(replacement);
}

// --- tracking-link resolution (after raw spool, before immutable body write) ---

export type FetchLike = (
  url: string,
  init: { method: string; redirect: "manual"; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

export interface ResolveTrackingOptions {
  fetchFn: FetchLike;
  maxLinks?: number;
  resolveHost?: HostResolver;
}

const MD_LINK_URL = /\]\((https?:\/\/[^\s()]+)((?:\s+"[^"]*")?)\)/g;
const MAX_REDIRECTS = 5;
const RESOLVE_TIMEOUT_MS = 10_000;

export function isTrackingHost(raw: string): boolean {
  try {
    return isTrackingUrl(new URL(raw));
  } catch {
    return false;
  }
}

function isTrackingUrl(u: URL): boolean {
  const h = u.hostname.toLowerCase();
  if (/^email\.mg[^.]*\.substack\.com$/.test(h)) return true;
  if (
    (h === "substack.com" || h === "www.substack.com") &&
    u.pathname.startsWith("/redirect")
  ) {
    return true;
  }
  if (
    (h === "list-manage.com" || h.endsWith(".list-manage.com")) &&
    u.pathname.startsWith("/track")
  ) {
    return true;
  }
  if (h === "link.mail.beehiiv.com") return true;
  if (/^clicks\.convertkit-mail[^.]*\.com$/.test(h)) return true;
  if (/^(?:click|links|trk)\./.test(h)) return true;
  return false;
}

export async function resolveTrackingLinks(
  md: string,
  opts: ResolveTrackingOptions,
): Promise<string> {
  const maxLinks = opts.maxLinks ?? 30;
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const m of md.matchAll(MD_LINK_URL)) {
    const raw = m[1];
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (!isTrackingHost(raw)) continue;
    candidates.push(raw);
    if (candidates.length >= maxLinks) break;
  }
  if (candidates.length === 0) return md;

  const resolved = new Map<string, string>();
  await Promise.all(
    candidates.map(async (raw) => {
      const finalUrl = await followRedirects(raw, opts.fetchFn, opts.resolveHost);
      if (finalUrl && finalUrl !== raw) resolved.set(raw, finalUrl);
    }),
  );
  if (resolved.size === 0) return md;

  return md.replace(MD_LINK_URL, (whole, url: string, title: string) => {
    const r = resolved.get(url);
    return r ? `](${r}${title})` : whole;
  });
}

// Any failure returns null so the caller leaves the original link untouched.
async function followRedirects(
  url: string,
  fetchFn: FetchLike,
  resolveHost?: HostResolver,
): Promise<string | null> {
  let current: string;
  let method = "HEAD";
  let redirects = 0;
  try {
    current = await safeResolvedWebUrl(url, undefined, resolveHost);
    for (;;) {
      const res = await fetchFn(current, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      });
      if (res.status === 405 && method === "HEAD") {
        method = "GET";
        continue;
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return null;
        if (++redirects > MAX_REDIRECTS) return null;
        current = await safeResolvedWebUrl(loc, current, resolveHost);
        continue;
      }
      if (res.status >= 200 && res.status < 300) return current;
      // error status after at least one hop still names the real destination
      return redirects > 0 ? current : null;
    }
  } catch {
    return null;
  }
}
