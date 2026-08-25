import { expect, test } from "bun:test";
import type { WordholdConfig } from "../core/types.ts";
import { allowSender } from "../scripts/allow-sender.ts";
import { syncSenders } from "../scripts/sync-senders.ts";

const config: WordholdConfig = {
  worker: { baseUrl: "https://worker.example/", secret: "private-secret" },
  icloudInboxDir: "",
  readingListPlist: "",
  imessage: { recipient: "", dryRun: true },
  enrichment: { minBodyChars: 100, maxFetchAttempts: 3 },
};

test("allowSender makes one authenticated, normalized Worker request", async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const result = await allowSender(config, " Writer@Example.COM ", async (url, init) => {
    seen = { url: String(url), init };
    return Response.json({ address: "writer@example.com", unquarantined: 2 });
  });
  expect(result).toEqual({ address: "writer@example.com", unquarantined: 2 });
  expect(seen?.url).toBe("https://worker.example/v1/allow");
  expect(seen?.init?.method).toBe("POST");
  expect(seen?.init?.headers).toEqual({
    authorization: "Bearer private-secret",
    "content-type": "application/json",
  });
  expect(seen?.init?.body).toBe(JSON.stringify({ address: "writer@example.com" }));
});

test("allowSender rejects an invalid address before network access", async () => {
  let called = false;
  expect(
    allowSender(config, "not-an-address", async () => {
      called = true;
      return Response.json({});
    }),
  ).rejects.toThrow("valid sender email required");
  expect(called).toBe(false);
});

test("syncSenders calls the authenticated upgrade endpoint", async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const synced = await syncSenders(config, async (url, init) => {
    seen = { url: String(url), init };
    return Response.json({ synced: 3 });
  });
  expect(synced).toBe(3);
  expect(seen?.url).toBe("https://worker.example/v1/sync-senders");
  expect(seen?.init?.method).toBe("POST");
  expect(seen?.init?.headers).toEqual({
    authorization: "Bearer private-secret",
  });
});
