import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIcloudInboxAdapter,
  moveToBadCaptures,
} from "../daemon/adapters/icloud-inbox.ts";
import type { AdapterContext } from "../core/types.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "adapters");

let repoRoot: string;
let inboxDir: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "pt-icloud-"));
  inboxDir = join(repoRoot, "icloud");
  mkdirSync(inboxDir, { recursive: true });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function ctx(dir: string = inboxDir): AdapterContext {
  return {
    repoRoot,
    config: {
      worker: { baseUrl: "", secret: "" },
      icloudInboxDir: dir,
      readingListPlist: join(repoRoot, "Bookmarks.plist"),
      imessage: { recipient: "", dryRun: true },
      enrichment: { minBodyChars: 600, maxFetchAttempts: 5 },
    },
  };
}

function writeCapture(name: string, fixture: string): void {
  writeFileSync(
    join(inboxDir, name),
    readFileSync(join(FIXTURES, fixture), "utf8"),
  );
}

function settledAdapter() {
  return createIcloudInboxAdapter({ now: () => Date.now() + 10_000 });
}

test("pull parses save and highlight capture files into Captures", async () => {
  writeCapture("papertrail-001-save.json", "shortcut-save.json");
  writeCapture("papertrail-002-highlight.json", "shortcut-highlight.json");
  const adapter = settledAdapter();
  const captures = await adapter.pull(ctx());

  expect(captures).toHaveLength(2);
  const [save, highlight] = captures;
  expect(save.kind).toBe("save");
  expect(save.source).toBe("shortcut");
  expect(save.url).toBe("https://example.com/essay?utm_source=share");
  expect(save.title).toBe("An Essay Worth Saving");
  expect(save.capturedAt).toBe("2026-07-01T09:15:00.000Z");
  expect(save.idempotencyKey).toBe("papertrail-001-save.json");

  expect(highlight.kind).toBe("highlight");
  expect(highlight.source).toBe("highlight_share");
  expect(highlight.text).toBe(
    "The passage he actually marked with his own thumb.",
  );
  expect(highlight.idempotencyKey).toBe("papertrail-002-highlight.json");
  expect(adapter.note).toBeUndefined();
});

test("pull preserves a text-only Shortcut share as a note", async () => {
  writeFileSync(
    join(inboxDir, "papertrail-003-note.json"),
    JSON.stringify({
      kind: "note",
      text: "Message text with no reliable page context.",
      capturedAt: "2026-08-04T16:00:00Z",
      idempotencyKey: "shared-shortcut-identity",
    }),
  );
  const captures = await createIcloudInboxAdapter().pull(ctx());
  expect(captures).toEqual([
    {
      kind: "note",
      source: "shortcut",
      text: "Message text with no reliable page context.",
      capturedAt: "2026-08-04T16:00:00.000Z",
      idempotencyKey: "shared-shortcut-identity",
      upstreamId: "papertrail-003-note.json",
    },
  ]);
});

test("0.3.6 Link payload uses its unique filename as the stable capture identity", async () => {
  const name = "papertrail-link-0.3.6-123456789012.json";
  writeFileSync(join(inboxDir, name), JSON.stringify({
    kind: "save",
    url: "https://example.com/papertrail-link-recovery",
    buildMarker: "papertrail-link-0.3.6",
  }));

  expect(await settledAdapter().pull(ctx())).toEqual([
    expect.objectContaining({
      kind: "save",
      source: "shortcut",
      url: "https://example.com/papertrail-link-recovery",
      idempotencyKey: name,
      upstreamId: name,
    }),
  ]);
});

test("0.3.7 iOS text handoff is accepted only through its exact envelope", async () => {
  const candidateName = "papertrail-link-0.3.7-123456789-987654321.txt";
  writeFileSync(join(inboxDir, candidateName), JSON.stringify({
    kind: "save",
    url: "https://www.iana.org/help/example-domains",
    buildMarker: "papertrail-link-0.3.7",
  }));
  writeFileSync(
    join(inboxDir, "papertrail-link-0.3.7-111111111-222222222.txt"),
    JSON.stringify({
      kind: "save",
      url: "https://example.com/wrong-marker",
      buildMarker: "papertrail-link-0.3.6",
    }),
  );
  const disprovenName = "papertrail-link-0.3.6-2147483647.txt";
  writeFileSync(join(inboxDir, disprovenName), JSON.stringify({
    kind: "save",
    url: "https://example.com/disproven",
    buildMarker: "papertrail-link-0.3.6",
  }));
  writeFileSync(
    join(inboxDir, "papertrail-unrelated.txt"),
    JSON.stringify({ kind: "save", url: "https://example.com/untouched" }),
  );

  const adapter = settledAdapter();
  expect(await adapter.pull(ctx())).toEqual([
    expect.objectContaining({
      kind: "save",
      source: "shortcut",
      url: "https://www.iana.org/help/example-domains",
      idempotencyKey: candidateName,
      upstreamId: candidateName,
    }),
  ]);
  expect(
    existsSync(join(repoRoot, "logs", "bad-captures", "papertrail-link-0.3.7-111111111-222222222.txt")),
  ).toBe(true);
  expect(existsSync(join(inboxDir, disprovenName))).toBe(true);
  expect(existsSync(join(inboxDir, "papertrail-unrelated.txt"))).toBe(true);

  await adapter.ack?.(ctx(), await adapter.pull(ctx()));
  expect(existsSync(join(inboxDir, candidateName))).toBe(false);
});

test("ack maps a shared capture identity back to its iCloud filename", async () => {
  const path = join(inboxDir, "papertrail-generated-note.json");
  writeFileSync(
    path,
    JSON.stringify({
      kind: "note",
      text: "One note delivered through two transports.",
      capturedAt: "2026-08-04T16:00:00Z",
      idempotencyKey: "shared-shortcut-identity",
    }),
  );
  const adapter = settledAdapter();
  const captures = await adapter.pull(ctx());
  expect(captures[0]?.idempotencyKey).toBe("shared-shortcut-identity");
  await adapter.ack?.(ctx(), captures);
  expect(existsSync(path)).toBe(false);
});

test("ack deletes exactly the committed files, leaving the rest", async () => {
  writeCapture("papertrail-001-save.json", "shortcut-save.json");
  writeCapture("papertrail-002-highlight.json", "shortcut-highlight.json");
  const adapter = createIcloudInboxAdapter();
  const captures = await adapter.pull(ctx());

  const committed = captures.filter(
    (c) => c.idempotencyKey === "papertrail-001-save.json",
  );
  await adapter.ack?.(ctx(), committed);

  expect(existsSync(join(inboxDir, "papertrail-001-save.json"))).toBe(false);
  expect(existsSync(join(inboxDir, "papertrail-002-highlight.json"))).toBe(
    true,
  );
});

test("ack tolerates already-deleted files (at-least-once replay)", async () => {
  writeCapture("papertrail-001-save.json", "shortcut-save.json");
  const adapter = createIcloudInboxAdapter();
  const captures = await adapter.pull(ctx());
  await adapter.ack?.(ctx(), captures);
  await adapter.ack?.(ctx(), captures); // second ack of same captures: no throw
  expect(existsSync(join(inboxDir, "papertrail-001-save.json"))).toBe(false);
});

test("malformed JSON is moved to logs/bad-captures, never deleted or thrown", async () => {
  writeCapture("papertrail-001-save.json", "shortcut-save.json");
  const badRaw = "this is {{{ not json";
  writeFileSync(join(inboxDir, "papertrail-bad.json"), badRaw);
  writeFileSync(
    join(inboxDir, "papertrail-badkind.json"),
    JSON.stringify({ kind: "mystery", url: "https://example.com" }),
  );

  const adapter = settledAdapter();
  const captures = await adapter.pull(ctx());

  expect(captures).toHaveLength(1);
  expect(captures[0].idempotencyKey).toBe("papertrail-001-save.json");
  const badDir = join(repoRoot, "logs", "bad-captures");
  expect(readFileSync(join(badDir, "papertrail-bad.json"), "utf8")).toBe(
    badRaw,
  );
  expect(existsSync(join(badDir, "papertrail-badkind.json"))).toBe(true);
  expect(existsSync(join(inboxDir, "papertrail-bad.json"))).toBe(false);
  expect(existsSync(join(inboxDir, "papertrail-badkind.json"))).toBe(false);
  expect(statSync(badDir).mode & 0o777).toBe(0o700);
  expect(statSync(join(badDir, "papertrail-bad.json")).mode & 0o777).toBe(
    0o600,
  );
  expect(adapter.note).toContain("2 Shortcut captures rejected");
});

test("malformed capture quarantine preserves an existing same-name evidence file", async () => {
  const badRaw = "{ malformed but still recoverable\n";
  const source = join(inboxDir, "papertrail-collision.json");
  writeFileSync(source, badRaw);
  const badDir = join(repoRoot, "logs", "bad-captures");
  mkdirSync(badDir, { recursive: true });
  const existing = join(badDir, "papertrail-collision.json");
  writeFileSync(existing, "older evidence\n");

  const captures = await settledAdapter().pull(ctx());

  expect(captures).toEqual([]);
  expect(readFileSync(existing, "utf8")).toBe("older evidence\n");
  expect(readFileSync(`${existing}.1`, "utf8")).toBe(badRaw);
  expect(existsSync(source)).toBe(false);
});

test("reviewed quarantine evidence stays byte-exact while a corrected copy requeues", async () => {
  const badName = "papertrail-link-0.3.6-bad.json";
  const badRaw = "{ malformed recovery evidence\n";
  writeFileSync(join(inboxDir, badName), badRaw);

  expect(await settledAdapter().pull(ctx())).toEqual([]);
  const quarantined = join(repoRoot, "logs", "bad-captures", badName);
  expect(readFileSync(quarantined, "utf8")).toBe(badRaw);

  const correctedName = "papertrail-link-0.3.6-reviewed-123456789012.json";
  writeFileSync(join(inboxDir, correctedName), JSON.stringify({
    kind: "save",
    url: "https://example.com/reviewed-requeue",
    buildMarker: "papertrail-link-0.3.6",
  }));
  const adapter = settledAdapter();
  const captures = await adapter.pull(ctx());
  expect(captures).toEqual([
    expect.objectContaining({
      url: "https://example.com/reviewed-requeue",
      idempotencyKey: correctedName,
      upstreamId: correctedName,
    }),
  ]);
  await adapter.ack?.(ctx(), captures);
  expect(readFileSync(quarantined, "utf8")).toBe(badRaw);
  expect(existsSync(join(inboxDir, correctedName))).toBe(false);
});

test("cross-volume quarantine uses an atomic byte copy before removing source", () => {
  const source = join(inboxDir, "papertrail-cross-volume.json");
  const badRaw = "{ byte-exact oversized iCloud evidence\n".repeat(20_000);
  writeFileSync(source, badRaw);

  moveToBadCaptures(repoRoot, source, {
    rename: () => {
      const error = new Error("simulated cross-volume rename") as NodeJS.ErrnoException;
      error.code = "EXDEV";
      throw error;
    },
  });

  expect(existsSync(source)).toBe(false);
  expect(
    readFileSync(
      join(repoRoot, "logs", "bad-captures", "papertrail-cross-volume.json"),
      "utf8",
    ),
  ).toBe(badRaw);
});

test("invalid Shortcut fields are quarantined with reasons, never returned for ack", async () => {
  const invalid: Record<string, unknown> = {
    "papertrail-missing-save-url.json": { kind: "save", title: "No URL" },
    "papertrail-missing-highlight-text.json": {
      kind: "highlight",
      url: "https://example.com",
    },
    "papertrail-wrong-type.json": {
      kind: "save",
      url: "https://example.com",
      title: 42,
    },
    "papertrail-hostile-date.json": {
      kind: "highlight",
      text: "marked",
      capturedAt: "../../2026",
    },
    "papertrail-locale-date.json": {
      kind: "highlight",
      text: "marked",
      capturedAt: "01/02/2026",
    },
    "papertrail-private-url.json": {
      kind: "save",
      url: "http://127.0.0.1/private",
    },
  };
  for (const [name, body] of Object.entries(invalid)) {
    writeFileSync(join(inboxDir, name), JSON.stringify(body));
  }

  const adapter = settledAdapter();
  expect(await adapter.pull(ctx())).toEqual([]);

  for (const name of Object.keys(invalid)) {
    expect(existsSync(join(inboxDir, name))).toBe(false);
    expect(existsSync(join(repoRoot, "logs", "bad-captures", name))).toBe(true);
  }
  const log = readFileSync(join(repoRoot, "logs", "daemon.log"), "utf8");
  expect(log).toContain("papertrail-missing-save-url.json");
  expect(log).toContain("papertrail-hostile-date.json");
  expect(log).toContain("papertrail-locale-date.json");
  expect(log).toContain("invalid Shortcut capture");
});

test("oversized Shortcut bytes are quarantined before JSON parsing while later work proceeds", async () => {
  const oversized = " ".repeat(41 * 1024) + JSON.stringify({
    kind: "note",
    text: "small content hidden in an oversized envelope",
  });
  writeFileSync(join(inboxDir, "papertrail-001-oversized.json"), oversized);
  writeFileSync(
    join(inboxDir, "papertrail-002-valid.json"),
    JSON.stringify({ kind: "note", text: "later valid capture" }),
  );

  const captures = await createIcloudInboxAdapter().pull(ctx());

  expect(captures).toEqual([
    expect.objectContaining({ kind: "note", text: "later valid capture" }),
  ]);
  expect(
    readFileSync(
      join(repoRoot, "logs", "bad-captures", "papertrail-001-oversized.json"),
      "utf8",
    ),
  ).toBe(oversized);
  expect(readFileSync(join(repoRoot, "logs", "daemon.log"), "utf8"))
    .toContain("file exceeds 40960 bytes");
});

test("a transient iCloud read failure is deferred without quarantining valid evidence", async () => {
  const name = "papertrail-transient.json";
  const path = join(inboxDir, name);
  writeFileSync(path, JSON.stringify({
    kind: "note",
    text: "Valid after File Provider finishes downloading.",
    capturedAt: "2026-08-10T12:00:00Z",
  }));
  let attempts = 0;
  const adapter = createIcloudInboxAdapter({
    readFile: (candidate, limit) => {
      attempts += 1;
      if (attempts === 1) throw new Error("simulated EDEADLK");
      const bytes = readFileSync(candidate);
      if (bytes.byteLength > limit) throw new Error("unexpected oversized fixture");
      return bytes;
    },
  });

  expect(await adapter.pull(ctx())).toEqual([]);
  expect(existsSync(path)).toBe(true);
  expect(existsSync(join(repoRoot, "logs", "bad-captures", name))).toBe(false);
  expect(readFileSync(join(repoRoot, "logs", "daemon.log"), "utf8"))
    .toContain("deferred unreadable Shortcut capture");
  expect(await adapter.pull(ctx())).toEqual([
    expect.objectContaining({ text: "Valid after File Provider finishes downloading." }),
  ]);
});

test("a fresh successful partial read is deferred until the complete file arrives", async () => {
  const name = "papertrail-partial.json";
  const path = join(inboxDir, name);
  writeFileSync(path, '{"kind":"note","text":"still syncing"');
  const adapter = createIcloudInboxAdapter();

  expect(await adapter.pull(ctx())).toEqual([]);
  expect(existsSync(path)).toBe(true);
  expect(existsSync(join(repoRoot, "logs", "bad-captures", name))).toBe(false);
  writeFileSync(path, JSON.stringify({
    kind: "note",
    text: "Complete after File Provider sync.",
    capturedAt: "2026-08-10T12:00:00Z",
  }));
  expect(await adapter.pull(ctx())).toEqual([
    expect.objectContaining({ text: "Complete after File Provider sync." }),
  ]);
});

test("a transient quarantine move leaves evidence for retry and later files progress", async () => {
  const bad = join(inboxDir, "papertrail-001-invalid.json");
  writeFileSync(bad, "{ malformed");
  writeFileSync(
    join(inboxDir, "papertrail-002-valid.json"),
    JSON.stringify({ kind: "note", text: "Independent valid capture." }),
  );
  const adapter = createIcloudInboxAdapter({
    now: () => Date.now() + 10_000,
    moveToBad: () => {
      throw new Error("simulated File Provider EDEADLK");
    },
  });

  expect(await adapter.pull(ctx())).toEqual([
    expect.objectContaining({ text: "Independent valid capture." }),
  ]);
  expect(existsSync(bad)).toBe(true);
  expect(readFileSync(join(repoRoot, "logs", "daemon.log"), "utf8"))
    .toContain("deferred Shortcut quarantine");
});

test("undownloaded .icloud placeholders are counted, not failed on", async () => {
  writeCapture("papertrail-001-save.json", "shortcut-save.json");
  writeFileSync(join(inboxDir, ".papertrail-002-highlight.json.icloud"), "");
  writeFileSync(join(inboxDir, ".papertrail-003-save.json.icloud"), "");
  writeFileSync(
    join(inboxDir, ".papertrail-link-0.3.7-123456789-987654321.txt.icloud"),
    "",
  );

  const adapter = createIcloudInboxAdapter();
  const captures = await adapter.pull(ctx());

  expect(captures).toHaveLength(1);
  expect(adapter.icloudPlaceholderCount).toBe(3);
});

test("non-papertrail files are ignored and untouched", async () => {
  writeFileSync(join(inboxDir, "someone-elses-shortcut.json"), "{}");
  writeFileSync(join(inboxDir, "notes.txt"), "hello");

  const adapter = createIcloudInboxAdapter();
  const captures = await adapter.pull(ctx());

  expect(captures).toHaveLength(0);
  expect(existsSync(join(inboxDir, "someone-elses-shortcut.json"))).toBe(true);
  expect(existsSync(join(inboxDir, "notes.txt"))).toBe(true);
});

test("missing inbox dir returns [] with a note, not an error", async () => {
  const adapter = createIcloudInboxAdapter();
  const captures = await adapter.pull(ctx(join(repoRoot, "does-not-exist")));
  expect(captures).toEqual([]);
  expect(adapter.note).toContain("Shortcuts not set up");
});
