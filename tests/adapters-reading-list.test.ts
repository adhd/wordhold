import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadingListAdapter } from "../daemon/adapters/reading-list.ts";
import { AdapterHardError, type AdapterContext } from "../core/types.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "adapters");

let repoRoot: string;
let plistPath: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "pt-readinglist-"));
  plistPath = join(repoRoot, "Bookmarks.plist");
});

afterEach(() => {
  if (existsSync(plistPath)) chmodSync(plistPath, 0o644); // undo chmod-000 tests
  rmSync(repoRoot, { recursive: true, force: true });
});

function ctx(): AdapterContext {
  return {
    repoRoot,
    config: {
      worker: { baseUrl: "", secret: "" },
      icloudInboxDir: join(repoRoot, "icloud"),
      readingListPlist: plistPath,
      imessage: { recipient: "", dryRun: true },
      enrichment: { minBodyChars: 600, maxFetchAttempts: 5 },
    },
  };
}

async function buildBinaryPlist(sourceFixture: string): Promise<void> {
  const proc = Bun.spawn(
    [
      "plutil",
      "-convert",
      "binary1",
      "-o",
      plistPath,
      join(FIXTURES, sourceFixture),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if ((await proc.exited) !== 0) {
    throw new Error(await new Response(proc.stderr).text());
  }
}

test("pull parses the ReadingList folder of a binary plist into save Captures", async () => {
  await buildBinaryPlist("reading-list.json");
  const adapter = createReadingListAdapter();
  const captures = await adapter.pull(ctx());

  expect(captures).toHaveLength(2); // no-URL entry skipped, other folders ignored
  const urls = captures.map((c) => c.url);
  expect(urls).toContain("https://example.com/one");
  expect(urls).toContain("https://example.com/two");
  expect(urls).not.toContain("https://example.com/regular-bookmark");

  const one = captures.find((c) => c.url === "https://example.com/one");
  expect(one?.kind).toBe("save");
  expect(one?.source).toBe("reading_list");
  expect(one?.title).toBe("Article One");
  expect(one?.capturedAt).toBe("2026-06-01T12:34:56Z");
  expect(adapter.note).toBeUndefined();
});

test("pull handles real <date> values (plutil cannot emit them as JSON)", async () => {
  await buildBinaryPlist("reading-list-dates.xml");
  const adapter = createReadingListAdapter();
  const captures = await adapter.pull(ctx());

  expect(captures).toHaveLength(1);
  expect(captures[0].url).toBe("https://example.com/dated");
  expect(captures[0].title).toBe("Dated Entry");
  expect(captures[0].capturedAt).toBe("2026-05-20T07:08:09Z");
});

test("append-only: every pull returns the full current list", async () => {
  await buildBinaryPlist("reading-list.json");
  const adapter = createReadingListAdapter();
  const first = await adapter.pull(ctx());
  const second = await adapter.pull(ctx());
  expect(second.map((c) => c.url).sort()).toEqual(
    first.map((c) => c.url).sort(),
  );
  expect(adapter.ack).toBeUndefined(); // deletions upstream are ignored, nothing to ack
});

test("permission denial throws AdapterHardError naming Full Disk Access", async () => {
  await buildBinaryPlist("reading-list.json");
  chmodSync(plistPath, 0o000); // stat still succeeds, open fails: the TCC shape
  const adapter = createReadingListAdapter();

  const err = await adapter.pull(ctx()).catch((e) => e);
  expect(err).toBeInstanceOf(AdapterHardError);
  expect((err as AdapterHardError).adapterName).toBe("reading_list");
  expect((err as AdapterHardError).message).toContain("Full Disk Access");
});

test("missing plist returns [] with a note, not an error", async () => {
  const adapter = createReadingListAdapter();
  const captures = await adapter.pull(ctx());
  expect(captures).toEqual([]);
  expect(adapter.note).toContain("Bookmarks.plist");
});

test("a plist without a ReadingList folder yields no captures", async () => {
  writeFileSync(
    join(repoRoot, "no-rl.json"),
    JSON.stringify({
      WebBookmarkFileVersion: 1,
      Children: [{ Title: "BookmarksBar", Children: [] }],
    }),
  );
  const proc = Bun.spawn(
    [
      "plutil",
      "-convert",
      "binary1",
      "-o",
      plistPath,
      join(repoRoot, "no-rl.json"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await proc.exited).toBe(0);

  const adapter = createReadingListAdapter();
  expect(await adapter.pull(ctx())).toEqual([]);
});
