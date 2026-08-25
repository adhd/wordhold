import { expect, test } from "bun:test";
import { createPublicWebFetch } from "../daemon/public-fetch.ts";

test("production transport connects to the vetted address with original Host and SNI", async () => {
  let seenUrl = "";
  let seenInit: (RequestInit & { tls?: { serverName?: string } }) | undefined;
  const fetchPublic = createPublicWebFetch({
    resolveHost: async () => ["93.184.216.34"],
    transport: async (input, init) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response("ok");
    },
  });

  await fetchPublic("https://rebind.example:8443/article", {
    redirect: "manual",
  });

  expect(seenUrl).toBe("https://93.184.216.34:8443/article");
  expect(new Headers(seenInit?.headers).get("host")).toBe(
    "rebind.example:8443",
  );
  expect(seenInit?.tls?.serverName).toBe("rebind.example");
  expect(seenInit?.redirect).toBe("manual");
});

test("a private resolution is rejected before the transport boundary", async () => {
  let calls = 0;
  const fetchPublic = createPublicWebFetch({
    resolveHost: async () => ["127.0.0.1"],
    transport: async () => {
      calls += 1;
      return new Response("should not run");
    },
  });
  await expect(fetchPublic("https://rebind.example/article")).rejects.toThrow(
    "does not resolve publicly",
  );
  expect(calls).toBe(0);
});
