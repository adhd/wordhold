import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  forbiddenWebHost,
  safeWebUrl,
  UnsafeUrlError,
} from "./web-url.ts";

export { safeWebUrl, UnsafeUrlError } from "./web-url.ts";

const STRIP_PARAMS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref_src",
]);
const TWITTER_ONLY_PARAMS = new Set(["s", "t"]);

function isTwitterHost(host: string): boolean {
  return (
    host === "twitter.com" ||
    host === "x.com" ||
    host.endsWith(".twitter.com") ||
    host.endsWith(".x.com")
  );
}

export type HostResolver = (hostname: string) => Promise<string[]>;

export const systemHostResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(
    (entry) => entry.address,
  );

export async function safeResolvedWebUrl(
  raw: string,
  base?: string,
  resolveHost?: HostResolver,
): Promise<string> {
  const normalized = safeWebUrl(raw, base);
  if (!resolveHost) return normalized;
  const hostname = new URL(normalized).hostname.replace(/^\[|\]$/g, "");
  const addresses = await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some(forbiddenWebHost)) {
    throw new UnsafeUrlError(`URL host does not resolve publicly: ${hostname}`);
  }
  return normalized;
}

export function normalizeUrl(raw: string): string {
  let s = raw.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = "https://" + s;
  const u = new URL(safeWebUrl(s)); // host/scheme policy plus URL normalization
  u.hash = "";
  const twitter = isTwitterHost(u.hostname);
  for (const key of [...u.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (
      k.startsWith("utm_") ||
      STRIP_PARAMS.has(k) ||
      (twitter && TWITTER_ONLY_PARAMS.has(k))
    ) {
      u.searchParams.delete(key);
    }
  }
  if (u.search === "" && u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }
  return u.toString();
}

export function urlHash(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function highlightDedupeKey(itemId: string, text: string): string {
  const norm = collapseWhitespace(text).toLowerCase();
  return createHash("sha256")
    .update(itemId + "\n" + norm)
    .digest("hex");
}

export function slugify(s: string, maxLen = 60): string {
  const slug = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
  return slug;
}

// Dedupe identity for emails with no canonical URL. Never stored as the item's
// url; lives in the dedupe_url frontmatter field.
export function newsletterPseudoUrl(
  senderDomain: string,
  subject: string,
  deliveryIdentity?: string,
): string {
  const domain = senderDomain.toLowerCase().replace(/^@/, "");
  const base = `newsletter://${domain}/${slugify(subject) || "untitled"}`;
  return deliveryIdentity
    ? `${base}/${urlHash(deliveryIdentity).slice(0, 16)}`
    : base;
}
