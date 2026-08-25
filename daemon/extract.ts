// Article fetch + extraction. extractFromHtml is the pure half so the email
// pipeline (web editions) and tests can use it with no network.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import {
  safeResolvedWebUrl,
  safeWebUrl,
  type HostResolver,
  UnsafeUrlError,
} from "../core/urls.ts";
import { publicWebFetch } from "./public-fetch.ts";

export type ExtractResult =
  | {
      ok: true;
      bodyMd: string;
      title?: string;
      author?: string;
      publishedAt?: string;
      canonicalUrl?: string;
      wordCount: number;
    }
  | { ok: false; reason: string; transient: boolean };

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchExtractOpts {
  fetchFn?: FetchLike;
  minBodyChars: number;
  timeoutMs?: number;
  maxBytes?: number;
  resolveHost?: HostResolver;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const BROWSER_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

function fail(reason: string, transient: boolean): ExtractResult {
  return { ok: false, reason, transient };
}

// Hosts we cannot extract from (players, JS shells). v1 records the honest
// failure instead of fetching and pretending; checked before any network.
function shortCircuit(rawUrl: string): ExtractResult | null {
  let u: URL;
  try {
    u = new URL(safeWebUrl(rawUrl));
  } catch {
    return fail("forbidden_url", false);
  }
  const host = u.hostname.toLowerCase();
  if (
    host === "youtu.be" ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com")
  ) {
    return fail("youtube_unsupported", false);
  }
  const xHost =
    host === "x.com" ||
    host === "twitter.com" ||
    host.endsWith(".x.com") ||
    host.endsWith(".twitter.com");
  if (xHost && /^\/[^/]+\/status(?:es)?\/\d+/.test(u.pathname)) {
    return fail("x_unsupported", false);
  }
  return null;
}

function isTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

// null = exceeded maxBytes mid-stream.
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<string | null> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export async function fetchAndExtract(
  url: string,
  opts: FetchExtractOpts,
): Promise<ExtractResult> {
  const short = shortCircuit(url);
  if (short) return short;

  const doFetch: FetchLike = opts.fetchFn ?? publicWebFetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const resolveHost = opts.resolveHost;

  let res: Response;
  let finalUrl: string;
  try {
    let current = await safeResolvedWebUrl(url, undefined, resolveHost);
    let redirects = 0;
    for (;;) {
      res = await doFetch(current, {
        redirect: "manual",
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status < 300 || res.status >= 400) {
        finalUrl = current;
        break;
      }
      const location = res.headers.get("location");
      if (!location || ++redirects > MAX_REDIRECTS) {
        return fail("redirect_invalid", false);
      }
      try {
        current = await safeResolvedWebUrl(location, current, resolveHost);
      } catch {
        return fail("redirect_forbidden", false);
      }
    }
  } catch (err) {
    if (err instanceof UnsafeUrlError) return fail("forbidden_url", false);
    return fail(isTimeout(err) ? "timeout" : "network_error", true);
  }

  if (!res.ok) {
    return fail(`http_${res.status}`, res.status >= 500 || res.status === 429);
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/pdf")) {
    return fail("pdf_unsupported", false);
  }
  if (
    contentType !== "" &&
    !contentType.includes("text/html") &&
    !contentType.includes("application/xhtml+xml")
  ) {
    return fail("not_html", false);
  }

  const declaredLen = res.headers.get("content-length");
  if (declaredLen && Number(declaredLen) > maxBytes) {
    return fail("too_large", false);
  }

  let html: string | null;
  try {
    html = await readCapped(res, maxBytes);
  } catch (err) {
    return fail(isTimeout(err) ? "timeout" : "network_error", true);
  }
  if (html === null) return fail("too_large", false);

  return extractFromHtml(html, finalUrl, opts.minBodyChars);
}

type ParsedDoc = ReturnType<typeof parseHTML>["document"];

function metaContent(
  document: ParsedDoc,
  selector: string,
): string | undefined {
  const v = document.querySelector(selector)?.getAttribute("content")?.trim();
  return v || undefined;
}

function readHeadMeta(document: ParsedDoc, baseUrl: string) {
  const canonicalHref =
    document
      .querySelector('link[rel="canonical"]')
      ?.getAttribute("href")
      ?.trim() || metaContent(document, 'meta[property="og:url"]');
  let canonicalUrl: string | undefined;
  if (canonicalHref) {
    try {
      canonicalUrl = safeWebUrl(canonicalHref, baseUrl);
    } catch {
      // unresolvable canonical is just absent
    }
  }
  // article:author is often a profile URL, not a name; skip those.
  const articleAuthor = metaContent(
    document,
    'meta[property="article:author"]',
  );
  const author =
    metaContent(document, 'meta[name="author"]') ??
    (articleAuthor && !/^https?:\/\//i.test(articleAuthor)
      ? articleAuthor
      : undefined);
  const publishedAt =
    metaContent(document, 'meta[property="article:published_time"]') ??
    metaContent(document, 'meta[name="article:published_time"]');
  return { canonicalUrl, author, publishedAt };
}

let td: TurndownService | null = null;

function toMarkdown(htmlFragment: string): string {
  if (!td) {
    td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
      emDelimiter: "*",
    });
    td.remove(["script", "style", "noscript"]);
  }
  return td.turndown(htmlFragment).trim();
}

export function extractFromHtml(
  html: string,
  url: string,
  minBodyChars: number,
): ExtractResult {
  const { document } = parseHTML(html);
  // Readability mutates the DOM, so read <head> metadata first.
  const meta = readHeadMeta(document, url);

  let article: ReturnType<Readability["parse"]>;
  try {
    // linkedom's document is structurally compatible with what Readability needs.
    // charThreshold follows minBodyChars down so the gate below is the one knob.
    article = new Readability(document as unknown as Document, {
      charThreshold: Math.min(500, Math.max(1, minBodyChars)),
    }).parse();
  } catch {
    return fail("extract_error", false);
  }
  if (!article || !article.content) return fail("thin_content", false);

  const textChars = (article.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim().length;
  if (textChars < minBodyChars) return fail("thin_content", false);

  const bodyMd = toMarkdown(article.content);
  if (bodyMd.length === 0) return fail("thin_content", false);

  const wordCount = bodyMd
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t)).length;

  const title = article.title?.trim() || undefined;
  const author = meta.author ?? (article.byline?.trim() || undefined);
  const publishedAt =
    meta.publishedAt ?? (article.publishedTime?.trim() || undefined);

  return {
    ok: true,
    bodyMd,
    wordCount,
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(meta.canonicalUrl ? { canonicalUrl: meta.canonicalUrl } : {}),
  };
}
