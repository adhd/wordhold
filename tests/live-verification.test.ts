import { expect, test } from "bun:test";
import type { WordholdConfig } from "../core/types.ts";
import { verifyLiveDigest } from "../scripts/verify-live-digest.ts";

const config: WordholdConfig = {
  worker: { baseUrl: "", secret: "" },
  icloudInboxDir: "",
  readingListPlist: "",
  imessage: { recipient: "configured-recipient", dryRun: true },
  enrichment: { minBodyChars: 100, maxFetchAttempts: 3 },
};

test("live digest verification refuses before delivery without authorization", async () => {
  let sends = 0;
  await expect(
    verifyLiveDigest(config, {
      send: async () => {
        sends += 1;
        return { sent: true, dryRun: false };
      },
    }),
  ).rejects.toThrow("refusing live send");
  expect(sends).toBe(0);
});

test("test authorization cannot fall through to the real sender", async () => {
  await expect(
    verifyLiveDigest(config, { authorizeForTest: () => true }),
  ).rejects.toThrow("test authorization requires an injected sender");
});

test("live digest verification sends one honest seeded paywall digest", async () => {
  const delivered: string[] = [];

  const result = await verifyLiveDigest(config, {
    authorizeForTest: () => true,
    now: new Date("2026-08-04T12:00:00.000Z"),
    send: async (_root, liveConfig, message) => {
      expect(liveConfig.imessage.recipient).toBe("configured-recipient");
      expect(liveConfig.imessage.dryRun).toBe(false);
      delivered.push(message);
      return { sent: true, dryRun: false };
    },
  });

  expect(result).toEqual({ sent: true, dryRun: false });
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toContain("Your week in Wordhold: 1 item");
  expect(delivered[0]).toContain(
    "Wordhold live verification — paywall_or_js_empty",
  );
});
