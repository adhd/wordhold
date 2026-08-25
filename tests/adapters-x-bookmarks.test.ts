import { expect, test } from "bun:test";
import { createXBookmarksAdapter } from "../daemon/adapters/x-bookmarks.ts";
import type { AdapterContext } from "../core/types.ts";

const ctx: AdapterContext = {
  repoRoot: "/nonexistent",
  config: {
    worker: { baseUrl: "", secret: "" },
    icloudInboxDir: "/nonexistent/icloud",
    readingListPlist: "/nonexistent/Bookmarks.plist",
    imessage: { recipient: "", dryRun: true },
    enrichment: { minBodyChars: 600, maxFetchAttempts: 5 },
  },
};

test("x_bookmarks is an interface-only stub in v1", async () => {
  const adapter = createXBookmarksAdapter();
  expect(adapter.name).toBe("x_bookmarks");
  expect(await adapter.pull(ctx)).toEqual([]);
  expect(adapter.note).toContain("v1 stub");
  expect(adapter.ack).toBeUndefined();
});
