import { isIP } from "node:net";
import {
  systemHostResolver,
  type HostResolver,
} from "../core/urls.ts";
import {
  forbiddenWebHost,
  safeWebUrl,
  UnsafeUrlError,
} from "../core/web-url.ts";

type PinnedRequestInit = RequestInit & {
  tls?: { serverName?: string };
};

export type PublicTransport = (
  input: string | URL,
  init?: PinnedRequestInit,
) => Promise<Response>;

// Resolve once, validate every answer, then connect to that exact address.
// The original Host header and TLS server name preserve virtual hosting and
// certificate verification without giving the transport a second DNS lookup.
export function createPublicWebFetch(
  deps: {
    resolveHost?: HostResolver;
    transport?: PublicTransport;
  } = {},
): PublicTransport {
  const resolveHost = deps.resolveHost ?? systemHostResolver;
  const transport = deps.transport ?? (fetch as PublicTransport);
  return async (input, init) => {
    const original = new URL(safeWebUrl(String(input)));
    const hostname = original.hostname.replace(/^\[|\]$/g, "");
    const addresses = await resolveHost(hostname);
    if (
      addresses.length === 0 ||
      addresses.some(
        (address) => isIP(address) === 0 || forbiddenWebHost(address),
      )
    ) {
      throw new UnsafeUrlError(
        `URL host does not resolve publicly: ${hostname}`,
      );
    }
    const address =
      addresses.find((candidate) => isIP(candidate) === 4) ?? addresses[0]!;
    const pinned = new URL(original);
    const addressHost = isIP(address) === 6 ? `[${address}]` : address;
    pinned.host = `${addressHost}${original.port ? `:${original.port}` : ""}`;
    const headers = new Headers(init?.headers);
    headers.set("host", original.host);
    const serverName = isIP(hostname) === 0 ? hostname : undefined;
    return transport(pinned, {
      ...init,
      headers,
      ...(original.protocol === "https:" && serverName
        ? { tls: { serverName } }
        : {}),
    });
  };
}

export const publicWebFetch = createPublicWebFetch();
