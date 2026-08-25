import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../core/db.ts";
import { recordSourceRun } from "../core/health.ts";
import {
  appendHighlight,
  ingestCapture,
  recordFetchResult,
  setEnrichment,
} from "../core/store.ts";
import { withWriterSession } from "../core/writer.ts";
import { listRawCaptures } from "../daemon/raw-spool.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runCli(root: string, ...args: string[]) {
  return Bun.spawnSync(["bun", join(import.meta.dir, "..", "cli", "pt.ts"), ...args], {
    env: { ...process.env, PAPERTRAIL_ROOT: root },
  });
}

function stdout(result: ReturnType<typeof runCli>): string {
  return new TextDecoder().decode(result.stdout);
}

function runCliWithInput(root: string, input: string, ...args: string[]) {
  return Bun.spawnSync(["bun", join(import.meta.dir, "..", "cli", "pt.ts"), ...args], {
    env: { ...process.env, PAPERTRAIL_ROOT: root },
    stdin: new TextEncoder().encode(input),
  });
}

function git(root: string, ...args: string[]): ReturnType<typeof Bun.spawnSync> {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return result;
}

test("CLI exposes recent, search, show, and a rebuildable corpus", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-cli-"));
  roots.push(root);
  let db = openDb(root);
  const { item } = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/context",
    title: "Durable Context",
    capturedAt: "2026-07-12T12:00:00.000Z",
  });
  recordFetchResult(
    root,
    db,
    item.id,
    { bodyMd: "A retrieval system keeps durable context available to future agents." },
    3,
  );
  setEnrichment(root, db, item.id, {
    summary: "Durable context improves later retrieval.",
    tags: ["memory systems"],
    aiHighlights: ["durable context available to future agents"],
  });
  db.close();

  const recent = runCli(root, "recent");
  expect(recent.exitCode).toBe(0);
  expect(stdout(recent)).toContain(`${item.id}\t2026-07-12\tDurable Context`);

  const search = runCli(root, "search", "durable", "context");
  expect(search.exitCode).toBe(0);
  expect(stdout(search)).toContain(item.id);
  expect(stdout(search)).toContain("[durable] [context]");

  const show = runCli(root, "show", item.id);
  expect(show.exitCode).toBe(0);
  expect(stdout(show)).toContain("Durable context improves later retrieval.");
  expect(stdout(show)).toContain("A retrieval system keeps durable context");

  rmSync(join(root, "papertrail.db"));
  const rebuild = runCli(root, "rebuild");
  expect(rebuild.exitCode).toBe(0);
  expect(stdout(rebuild)).toContain("rebuilt 1 item");
  db = openDb(root);
  expect((db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n).toBe(1);
  db.close();
});

test("CLI structured search returns bounded canonical evidence with explicit filters", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-cli-structured-search-"));
  roots.push(root);
  const db = openDb(root);
  const july = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/july-consensus",
    title: "Consensus in July",
    capturedAt: "2026-07-15T12:00:00.000Z",
  }).item;
  recordFetchResult(
    root,
    db,
    july.id,
    { bodyMd: "Distributed consensus needs quorum commitment and durable logs." },
    3,
  );
  setEnrichment(root, db, july.id, {
    summary: "A note about quorum-based consensus.",
    tags: ["distributed systems"],
    aiHighlights: [],
  });
  const august = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/august-consensus",
    title: "Consensus in August",
    capturedAt: "2026-08-02T12:00:00.000Z",
  }).item;
  recordFetchResult(
    root,
    db,
    august.id,
    { bodyMd: "Distributed consensus outside the requested window." },
    3,
  );
  db.close();

  const result = runCliWithInput(
    root,
    JSON.stringify({
      query: "distributed consensus",
      from: "2026-07-01",
      to: "2026-08-01",
      sources: ["shortcut"],
      statuses: ["enriched"],
      tags: ["distributed systems"],
      limit: 10,
    }),
    "search",
    "--json",
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(stdout(result))).toEqual({
    version: 1,
    operation: "search",
    query: {
      text: "distributed consensus",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
      sources: ["shortcut"],
      statuses: ["enriched"],
      tags: ["distributed systems"],
      limit: 10,
    },
    count: 1,
    hasMore: false,
    hits: [
      {
        id: july.id,
        title: "Consensus in July",
        url: "https://example.com/july-consensus",
        status: "enriched",
        sources: ["shortcut"],
        capturedAt: "2026-07-15T12:00:00.000Z",
        publishedAt: null,
        tags: ["distributed systems"],
        mdPath: july.mdPath,
        bodyAvailable: true,
        matchField: "body",
        snippet: "[Distributed] [consensus] needs quorum commitment and durable logs.",
      },
    ],
  });
});

test("structured retrieval distinguishes every evidence field, time edge, unavailable match, ambiguity, and no match", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-cli-retrieval-matrix-"));
  roots.push(root);
  const db = openDb(root);
  const atFrom = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/title-edge",
    title: "Boundary Zephyr",
    capturedAt: "2026-07-01T00:00:00.000Z",
  }).item;
  recordFetchResult(root, db, atFrom.id, { bodyMd: "Title-boundary evidence body." }, 3);
  const highlighted = ingestCapture(root, db, {
    kind: "save",
    source: "reading_list",
    url: "https://example.com/highlight",
    title: "Manual attention",
    capturedAt: "2026-07-10T12:00:00.000Z",
  }).item;
  recordFetchResult(root, db, highlighted.id, { bodyMd: "Ordinary article body." }, 3);
  appendHighlight(
    root,
    db,
    highlighted.id,
    "manual",
    "Peregrine evidence chosen by the reader.",
    "2026-07-10T12:01:00.000Z",
  );
  const context = ingestCapture(root, db, {
    kind: "save",
    source: "local_capture",
    url: "https://example.com/context-field",
    text: "Saffron surrounding commentary.",
    capturedAt: "2026-07-11T12:00:00.000Z",
  }).item;
  recordFetchResult(root, db, context.id, { bodyMd: "Different body words." }, 3);
  const unavailable = ingestCapture(root, db, {
    kind: "save",
    source: "reading_list",
    url: "https://example.com/unavailable-zephyr",
    title: "Unavailable Zephyr",
    capturedAt: "2026-07-12T12:00:00.000Z",
  }).item;
  recordFetchResult(root, db, unavailable.id, { error: "http_404", transient: false }, 3);
  for (const [suffix, day] of [["one", "20"], ["two", "21"]] as const) {
    const item = ingestCapture(root, db, {
      kind: "save",
      source: "shortcut",
      url: `https://example.com/ambiguous-${suffix}`,
      capturedAt: `2026-07-${day}T12:00:00.000Z`,
    }).item;
    recordFetchResult(root, db, item.id, { bodyMd: "Orchid ambiguity has two supporting items." }, 3);
  }
  const atTo = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/exclusive-edge",
    title: "Boundary Zephyr",
    capturedAt: "2026-08-01T00:00:00.000Z",
  }).item;
  recordFetchResult(root, db, atTo.id, { bodyMd: "Must be excluded." }, 3);
  db.close();

  const search = (request: Record<string, unknown>) => {
    const result = runCliWithInput(root, JSON.stringify(request), "search", "--json");
    expect(result.exitCode).toBe(0);
    return JSON.parse(stdout(result));
  };
  const boundary = search({
    query: "zephyr",
    from: "2026-07-01",
    to: "2026-08-01",
  });
  expect(boundary.hits).toHaveLength(2);
  expect(boundary.hits).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: atFrom.id, matchField: "title", bodyAvailable: true }),
    expect.objectContaining({ id: unavailable.id, matchField: "title", bodyAvailable: false }),
  ]));
  expect(boundary.hits.map((hit: { id: string }) => hit.id)).not.toContain(atTo.id);
  expect(search({ query: "peregrine" }).hits).toEqual([
    expect.objectContaining({ id: highlighted.id, matchField: "highlight" }),
  ]);
  expect(search({ query: "saffron" }).hits).toEqual([
    expect.objectContaining({ id: context.id, matchField: "context" }),
  ]);
  expect(search({ query: "orchid ambiguity" })).toMatchObject({ count: 2 });
  expect(search({ query: "definitelyabsentterm" })).toMatchObject({ count: 0, hits: [] });

  const badSyntax = runCliWithInput(root, JSON.stringify({ query: '"unterminated' }), "search", "--json");
  expect(badSyntax.exitCode).toBe(2);
  expect(new TextDecoder().decode(badSyntax.stderr)).toContain("invalid full-text query");
  const badFilter = runCliWithInput(
    root,
    JSON.stringify({ query: "zephyr", sources: ["unsupported"] }),
    "search",
    "--json",
  );
  expect(badFilter.exitCode).toBe(2);
  expect(new TextDecoder().decode(badFilter.stderr)).toContain("unsupported value");
  for (const request of [
    { query: "zephyr", source: "shortcut" },
    { query: "zephyr", from: "July 1, 2026" },
    { query: "zephyr", from: "2026-02-30" },
  ]) {
    const invalid = runCliWithInput(root, JSON.stringify(request), "search", "--json");
    expect(invalid.exitCode).toBe(2);
    expect(new TextDecoder().decode(invalid.stderr)).toMatch(/unsupported field|ISO date|valid ISO/);
  }
});

test("CLI structured item read returns deliberate bounded evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-cli-structured-item-"));
  roots.push(root);
  const db = openDb(root);
  const { item } = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/evidence",
    title: "Bounded Evidence",
    text: "The reader shared this because the failure model matters.",
    capturedAt: "2026-07-20T12:00:00.000Z",
  });
  const body = "Evidence must stay grounded in canonical text. ".repeat(20).trim();
  recordFetchResult(root, db, item.id, { bodyMd: body }, 3);
  const manual = appendHighlight(
    root,
    db,
    item.id,
    "manual",
    "The failure model matters.",
    "2026-07-20T13:00:00.000Z",
  ).highlight;
  setEnrichment(root, db, item.id, {
    summary: "Canonical evidence is returned in bounded form.",
    tags: ["retrieval"],
    aiHighlights: ["Evidence must stay grounded in canonical text."],
  });
  db.close();

  const result = runCliWithInput(
    root,
    JSON.stringify({ id: item.id, maxChars: 200 }),
    "show",
    "--json",
  );

  expect(result.exitCode).toBe(0);
  const evidence = JSON.parse(stdout(result));
  expect(evidence).toMatchObject({
    version: 1,
    operation: "get",
    item: {
      id: item.id,
      title: "Bounded Evidence",
      url: "https://example.com/evidence",
      status: "enriched",
      capturedAt: "2026-07-20T12:00:00.000Z",
      tags: ["retrieval"],
      summary: "Canonical evidence is returned in bounded form.",
      mdPath: item.mdPath,
      bodyAvailable: true,
      body: { text: body.slice(0, 200), totalChars: body.length, truncated: true },
      highlights: [
        { id: manual.id, origin: "manual", text: "The failure model matters." },
        {
          id: expect.stringMatching(/^hl_[a-z0-9]{10}$/),
          origin: "ai",
          text: "Evidence must stay grounded in canonical text.",
        },
      ],
      contexts: [
        {
          id: expect.stringMatching(/^cx_[a-z0-9]{10}$/),
          kind: "shared_text",
          source: "shortcut",
          text: "The reader shared this because the failure model matters.",
          capturedAt: "2026-07-20T12:00:00.000Z",
        },
      ],
    },
  });
});

test("CLI structured recent lists evidence availability without returning bodies", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-cli-structured-recent-"));
  roots.push(root);
  const db = openDb(root);
  const available = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/available",
    title: "Available evidence",
    capturedAt: "2026-07-01T12:00:00.000Z",
  }).item;
  recordFetchResult(root, db, available.id, { bodyMd: "A complete body." }, 3);
  const unavailable = ingestCapture(root, db, {
    kind: "save",
    source: "reading_list",
    url: "https://example.com/unavailable",
    title: "Unavailable evidence",
    capturedAt: "2026-07-02T12:00:00.000Z",
  }).item;
  recordFetchResult(
    root,
    db,
    unavailable.id,
    { error: "http_404", transient: false },
    3,
  );
  db.close();

  const result = runCliWithInput(
    root,
    JSON.stringify({ limit: 2 }),
    "recent",
    "--json",
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(stdout(result))).toEqual({
    version: 1,
    operation: "recent",
    query: { limit: 2 },
    count: 2,
    hasMore: false,
    nextCursor: null,
    items: [
      {
        id: unavailable.id,
        title: "Unavailable evidence",
        url: "https://example.com/unavailable",
        status: "fetch_failed",
        sources: ["reading_list"],
        capturedAt: "2026-07-02T12:00:00.000Z",
        publishedAt: null,
        tags: [],
        mdPath: unavailable.mdPath,
        bodyAvailable: false,
      },
      {
        id: available.id,
        title: "Available evidence",
        url: "https://example.com/available",
        status: "has_body",
        sources: ["shortcut"],
        capturedAt: "2026-07-01T12:00:00.000Z",
        publishedAt: null,
        tags: [],
        mdPath: available.mdPath,
        bodyAvailable: true,
      },
    ],
  });
  expect(stdout(result)).not.toContain("A complete body.");
});

test("CLI rejects unknown commands without mutating the corpus", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-cli-"));
  roots.push(root);
  const result = runCli(root, "everything-everywhere");
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("Usage:");
});

test("CLI queues a machine-readable capture from JSON stdin without a secret", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-cli-capture-"));
  roots.push(root);
  const result = runCliWithInput(
    root,
    JSON.stringify({
      input: "Worth saving https://example.com/from-agent",
      capturedAt: "2026-08-04T16:00:00Z",
      idempotencyKey: "hermes-1",
    }),
    "capture",
    "--json",
  );

  expect(result.exitCode).toBe(0);
  const receipt = JSON.parse(stdout(result)) as Record<string, unknown>;
  expect(receipt).toEqual({
    status: "queued",
    queueId: expect.stringMatching(/^[a-f0-9]{64}$/),
    kind: "save",
    url: "https://example.com/from-agent",
  });
  const queued = listRawCaptures(root);
  expect(queued).toHaveLength(1);
  expect(queued[0]?.adapterName).toBe("local_capture");
  expect(queued[0]?.capture.idempotencyKey).toBe("hermes-1");
});

test("CLI JSON stdin preserves shell-looking text literally", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-cli-literal-"));
  roots.push(root);
  const marker = join(root, "must-not-exist");
  const input = `Don't expand $(touch ${marker})\nor backticks: \`touch ${marker}\``;
  const result = runCliWithInput(
    root,
    JSON.stringify({ input, idempotencyKey: "literal-input-1" }),
    "capture",
    "--json",
  );

  expect(result.exitCode).toBe(0);
  expect(existsSync(marker)).toBe(false);
  expect(listRawCaptures(root)[0]?.capture.text).toBe(input);
});

test("CLI JSON boundary accepts highlights and rejects unsafe or ambiguous input", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-cli-validate-"));
  roots.push(root);
  const highlight = runCliWithInput(
    root,
    JSON.stringify({
      input: "Exact selected passage.",
      intent: "highlight",
      url: "https://example.com/source",
      title: "Source",
      idempotencyKey: "highlight-1",
    }),
    "capture",
    "--json",
  );
  expect(highlight.exitCode).toBe(0);
  expect(JSON.parse(stdout(highlight))).toMatchObject({
    status: "queued",
    kind: "highlight",
    url: "https://example.com/source",
  });

  for (const request of [
    { input: "See http://127.0.0.1/private" },
    { input: "https://example.com/one https://example.net/two" },
    { input: "x".repeat(25 * 1024), intent: "note" },
    { input: 42 },
  ]) {
    const result = runCliWithInput(
      root,
      JSON.stringify(request),
      "capture",
      "--json",
    );
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).not.toContain("PAPERTRAIL_SECRET");
  }
  expect(listRawCaptures(root)).toHaveLength(1);
});

test("CLI accepts a simple URL or text as a human capture command", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-cli-human-capture-"));
  roots.push(root);
  const result = runCli(root, "capture", "https://example.com/human");

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(stdout(result))).toMatchObject({
    status: "queued",
    kind: "save",
    url: "https://example.com/human",
  });
  expect(listRawCaptures(root)[0]?.capture.text).toBeUndefined();

  const note = runCli(root, "capture", "A plain thought with no URL");
  expect(note.exitCode).toBe(0);
  expect(JSON.parse(stdout(note))).toMatchObject({
    status: "queued",
    kind: "note",
  });
  expect(listRawCaptures(root).map((entry) => entry.capture.kind).sort()).toEqual([
    "note",
    "save",
  ]);
});

test("CLI health shows timestamps, staleness, and never-run scheduled jobs", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-cli-health-"));
  roots.push(root);
  const db = openDb(root);
  recordSourceRun(
    db,
    "worker_inbox",
    { ok: true, newItems: 0 },
    "2026-07-01T12:00:00.000Z",
  );
  db.close();
  const result = runCli(root, "health");
  expect(result.exitCode).not.toBe(0);
  expect(stdout(result)).toContain("worker_inbox\tSTALE");
  expect(stdout(result)).toContain("last run 2026-07-01T12:00:00.000Z");
  expect(stdout(result)).toContain("job:daemon\tNEVER RUN");
  expect(stdout(result)).toContain("job:enrichment\tNEVER RUN");
});

test("CLI structured health is machine-readable and redacts credential-shaped errors", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-cli-structured-health-"));
  roots.push(root);
  const db = openDb(root);
  const now = new Date().toISOString();
  recordSourceRun(
    db,
    "worker_inbox",
    { ok: false, newItems: 0, error: "authentication failed token=supersecret" },
    now,
  );
  db.close();

  const result = runCliWithInput(root, "{}", "health", "--json");

  expect(result.exitCode).toBe(1);
  const report = JSON.parse(stdout(result));
  expect(report).toMatchObject({
    version: 1,
    operation: "health",
    healthy: false,
    retainedWork: [],
  });
  expect(report.components).toContainEqual(
    expect.objectContaining({ name: "local_capture", state: "never_run" }),
  );
  expect(report.components).toContainEqual(
    expect.objectContaining({
      name: "worker_inbox",
      state: "failed",
      lastError: "authentication failed token=[REDACTED]",
      consecutiveFailures: 1,
    }),
  );
  expect(stdout(result)).not.toContain("supersecret");
});

test("CLI health degrades aged raw work but not a fresh in-flight record", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-cli-retained-health-"));
  roots.push(root);
  const db = openDb(root);
  const now = new Date();
  for (const source of [
    "local_capture",
    "worker_inbox",
    "icloud_inbox",
    "reading_list",
    "job:daemon",
    "job:enrichment",
    "job:resurface",
    "job:digest",
  ]) {
    recordSourceRun(db, source, { ok: true, newItems: 0 }, now.toISOString());
  }
  db.close();
  const rawDir = join(root, "inbox", "raw");
  mkdirSync(rawDir, { recursive: true });
  const rawPath = join(rawDir, `${"a".repeat(64)}.json`);
  writeFileSync(rawPath, "{}\n");
  const freshAt = new Date(now.getTime() - 14 * 60_000);
  utimesSync(rawPath, freshAt, freshAt);

  const fresh = runCli(root, "health");
  expect(fresh.exitCode).toBe(0);
  expect(stdout(fresh)).not.toContain("retained:raw_spool\tSTALE");

  const staleAt = new Date(now.getTime() - 16 * 60_000);
  utimesSync(rawPath, staleAt, staleAt);
  const stale = runCli(root, "health");
  expect(stale.exitCode).not.toBe(0);
  expect(stdout(stale)).toContain("retained:raw_spool\tSTALE");
  expect(stdout(stale)).toContain(`${"a".repeat(64)}.json`);

  utimesSync(rawPath, now, now);
  const intentDir = join(root, "inbox", "writer-intents");
  mkdirSync(intentDir, { recursive: true });
  const intentPath = join(intentDir, "daemon.json");
  writeFileSync(intentPath, '{"owner":"daemon","paths":[]}\n');
  utimesSync(intentPath, freshAt, freshAt);
  expect(runCli(root, "health").exitCode).toBe(0);

  utimesSync(intentPath, staleAt, staleAt);
  const staleIntent = runCli(root, "health");
  expect(staleIntent.exitCode).not.toBe(0);
  expect(stdout(staleIntent)).toContain("retained:writer_intents\tSTALE");
  expect(stdout(staleIntent)).toContain("inbox/writer-intents/daemon.json");
});

test("CLI rebuild commits a canonical merge recovered from a daemon crash", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-cli-recovery-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Papertrail Test");
  git(root, "config", "user.email", "papertrail@example.invalid");

  const db = openDb(root);
  const older = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/canonical",
    capturedAt: "2026-07-01T12:00:00.000Z",
  }).item;
  const newer = ingestCapture(root, db, {
    kind: "save",
    source: "reading_list",
    url: "https://tracker.example/click/123",
    capturedAt: "2026-07-02T12:00:00.000Z",
  }).item;
  git(root, "add", "--", older.mdPath, newer.mdPath);
  git(root, "commit", "-q", "--no-gpg-sign", "-m", "seed corpus");

  let interrupted = false;
  try {
    await withWriterSession(root, "daemon", async () => {
      recordFetchResult(
        root,
        db,
        newer.id,
        {
          bodyMd: "The recovered canonical article body.",
          canonicalUrl: "https://example.com/canonical",
        },
        3,
        {
          afterMergeWinnerWrite: () => {
            throw new Error("simulated crash");
          },
        },
      );
    });
  } catch (error) {
    interrupted = (error as Error).message === "simulated crash";
  }
  expect(interrupted).toBe(true);
  db.close();

  const result = runCli(root, "rebuild");
  expect(result.exitCode).toBe(0);
  expect(stdout(result)).toContain("rebuilt 1 item");
  expect(existsSync(join(root, newer.mdPath))).toBe(false);
  expect(
    existsSync(join(root, "inbox", "writer-intents", "daemon.json")),
  ).toBe(false);
  expect(stdout(git(root, "status", "--short", "--", "items"))).toBe("");
  expect(stdout(git(root, "log", "-1", "--pretty=%s"))).toContain(
    "maintenance: recover canonical writes",
  );
});
