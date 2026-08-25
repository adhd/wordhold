// Pure public-web URL policy shared by the Mac runtime and Cloudflare Worker.
// DNS resolution stays in core/urls.ts because the Worker has no node:dns.

function privateOrReservedIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function mappedIpv4(host: string): string | null {
  if (!host.startsWith("::ffff:")) return null;
  const tail = host.slice("::ffff:".length);
  if (tail.includes(".")) return tail;
  const words = tail.split(":");
  if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) {
    return null;
  }
  const high = Number.parseInt(words[0], 16);
  const low = Number.parseInt(words[1], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function forbiddenWebHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    privateOrReservedIpv4(host)
  ) {
    return true;
  }
  if (!host.includes(":")) return false;
  const mapped = mappedIpv4(host);
  return (
    host === "::" ||
    host === "::1" ||
    /^f[cd]/.test(host) ||
    /^fe[89ab]/.test(host) ||
    host.startsWith("ff") ||
    (mapped !== null && privateOrReservedIpv4(mapped))
  );
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export function safeWebUrl(raw: string, base?: string): string {
  const url = base ? new URL(raw, base) : new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`unsupported URL scheme ${url.protocol}`);
  }
  if (!url.hostname || forbiddenWebHost(url.hostname)) {
    throw new UnsafeUrlError(`forbidden URL host ${url.hostname || "(empty)"}`);
  }
  return url.toString();
}

/**
 * Return the exact origin used by Wordhold's Worker protocol.
 *
 * Worker routes are rooted at `/v1/*`; accepting a base path, query, or
 * fragment would let a readiness probe hit one URL while the daemon constructs
 * another. Production callers get the public-HTTPS policy. Local adapter tests
 * may explicitly allow HTTP/private origins without weakening the shape check.
 */
export function workerOrigin(
  raw: string,
  options: { allowHttp?: boolean; allowPrivate?: boolean } = {},
): string {
  const url = new URL(raw);
  if (
    (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:")) ||
    !url.hostname ||
    (!options.allowPrivate && forbiddenWebHost(url.hostname))
  ) {
    throw new UnsafeUrlError("Worker base URL must be a public HTTPS origin");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new UnsafeUrlError(
      "Worker base URL must be an origin without credentials, path, query, or fragment",
    );
  }
  return url.origin;
}
