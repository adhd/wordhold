import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkerInboxAdapter,
  type WorkerInboxRow,
} from "../daemon/adapters/worker-inbox.ts";
import { AdapterHardError, type AdapterContext } from "../core/types.ts";

const SECRET = "test-secret";

let repoRoot: string;
let server: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "pt-worker-"));
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(repoRoot, { recursive: true, force: true });
});

function ctx(baseUrl: string): AdapterContext {
  return {
    repoRoot,
    config: {
      worker: { baseUrl, secret: SECRET },
      icloudInboxDir: join(repoRoot, "icloud"),
      readingListPlist: join(repoRoot, "Bookmarks.plist"),
      imessage: { recipient: "", dryRun: true },
      enrichment: { minBodyChars: 600, maxFetchAttempts: 5 },
    },
  };
}

const ROWS: WorkerInboxRow[] = [
  {
    id: "row-save",
    kind: "save",
    receivedAt: "2026-07-01T10:00:00Z",
    payload: {
      url: "https://example.com/saved",
      title: "Saved Page",
      capturedAt: "2026-07-01T09:59:00Z",
    },
  },
  {
    id: "row-highlight",
    kind: "highlight",
    receivedAt: "2026-07-01T11:00:00Z",
    payload: {
      url: "https://example.com/hl",
      title: "Highlighted Page",
      text: "the marked passage",
    },
  },
  {
    id: "row-email",
    kind: "email",
    receivedAt: "2026-07-02T06:00:00Z",
    payload: {
      from: "letter@substack.com",
      subject: "Issue 42",
      bodyKey: "email-bodies/row-email.json",
      listPost: "https://letter.substack.com/p/issue-42",
      date: "2026-07-02T05:55:00Z",
    },
  },
  {
    id: "row-email-bare",
    kind: "email",
    receivedAt: "2026-07-02T07:00:00Z",
    payload: {
      from: "other@example.com",
      subject: "No canonical url",
      text: "body only",
    },
  },
  {
    id: "row-quarantined",
    kind: "email",
    receivedAt: "2026-07-02T08:00:00Z",
    quarantined: true,
    payload: { from: "spam@unknown.example", subject: "You won" },
  },
];

interface StubState {
  drainRequests: string[];
  bodyRequests: string[];
  ackBodies: unknown[];
}

// Serves ROWS across 3 pages (2 + 2 + 1) behind bearer auth.
function startStub(rows: WorkerInboxRow[] = ROWS): {
  baseUrl: string;
  state: StubState;
} {
  const state: StubState = { drainRequests: [], bodyRequests: [], ackBodies: [] };
  const pages = [rows.slice(0, 2), rows.slice(2, 4), rows.slice(4)];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== `Bearer ${SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      if (url.pathname === "/v1/drain") {
        state.drainRequests.push(url.pathname + url.search);
        const cursor = url.searchParams.get("cursor");
        const idx = cursor ? Number(cursor) : 0;
        const rowsPage = pages[idx] ?? [];
        const nextCursor = idx + 1 < pages.length ? String(idx + 1) : null;
        return Response.json({ rows: rowsPage, nextCursor });
      }
      if (url.pathname.startsWith("/v1/body/")) {
        state.bodyRequests.push(url.pathname);
        const id = decodeURIComponent(url.pathname.slice("/v1/body/".length));
        return Response.json({
          text: `plain body for ${id}`,
          html: `<p>plain body for ${id}</p>`,
        });
      }
      if (url.pathname === "/v1/ack" && req.method === "POST") {
        state.ackBodies.push(await req.json());
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}`, state };
}

test("pull paginates across 3 pages and maps rows to Captures", async () => {
  const { baseUrl, state } = startStub();
  const adapter = createWorkerInboxAdapter();
  const captures = await adapter.pull(ctx(baseUrl));

  expect(state.drainRequests).toEqual([
    "/v1/drain?limit=32",
    "/v1/drain?limit=32&cursor=1",
    "/v1/drain?limit=32&cursor=2",
  ]);
  expect(captures).toHaveLength(4); // quarantined row excluded

  const save = captures[0];
  expect(save.kind).toBe("save");
  expect(save.source).toBe("shortcut");
  expect(save.url).toBe("https://example.com/saved");
  expect(save.capturedAt).toBe("2026-07-01T09:59:00.000Z");
  expect(save.idempotencyKey).toBe("row-save");

  const highlight = captures[1];
  expect(highlight.kind).toBe("highlight");
  expect(highlight.source).toBe("highlight_share");
  expect(highlight.text).toBe("the marked passage");
  expect(highlight.capturedAt).toBe("2026-07-01T11:00:00.000Z"); // receivedAt fallback

  const email = captures[2];
  expect(email.kind).toBe("email");
  expect(email.source).toBe("newsletter");
  expect(email.emailFrom).toBe("letter@substack.com");
  expect(email.emailSubject).toBe("Issue 42");
  expect(email.url).toBe("https://letter.substack.com/p/issue-42");
  expect(email.capturedAt).toBe("2026-07-02T05:55:00.000Z");
  expect(email.text).toBe("plain body for row-email");
  expect(email.html).toBe("<p>plain body for row-email</p>");
  expect(state.bodyRequests).toEqual(["/v1/body/row-email"]);

  const bare = captures[3];
  expect(bare.url).toBeUndefined();
  expect(bare.capturedAt).toBe("2026-07-02T07:00:00.000Z"); // receivedAt fallback
});

test("the maximum requested drain page stays below the adapter response cap", async () => {
  const rows = Array.from({ length: 32 }, (_, index): WorkerInboxRow => ({
    id: `bounded-${index}`,
    kind: "save",
    receivedAt: "2026-08-10T12:00:00.000Z",
    payload: {
      url: `https://example.com/${index}`,
      html: "x".repeat(40 * 1024 - 512),
    },
  }));
  const quarantinedRows = Array.from({ length: 50 }, (_, index): WorkerInboxRow => ({
    id: `quarantine-${index}`,
    kind: "email",
    receivedAt: "2026-08-10T12:00:00.000Z",
    quarantined: true,
    payload: { from: "f".repeat(512), subject: "s".repeat(8 * 1024) },
  }));
  const body = JSON.stringify({ rows, quarantinedRows, nextCursor: null });
  expect(new TextEncoder().encode(body).byteLength).toBeLessThan(2 * 1024 * 1024);
  let request = "";
  const captures = await createWorkerInboxAdapter({
    fetchFn: async (input) => {
      request = String(input);
      return new Response(body, { headers: { "content-type": "application/json" } });
    },
  }).pull(ctx("https://worker.example"));
  expect(new URL(request).searchParams.get("limit")).toBe("32");
  expect(captures).toHaveLength(32);
});

test("pull preserves a Worker text note without fabricating highlight provenance", async () => {
  const { baseUrl } = startStub([
    {
      id: "row-note",
      kind: "note",
      receivedAt: "2026-08-04T16:00:00Z",
      payload: {
        text: "Shared without page context.",
        idempotencyKey: "shared-shortcut-identity",
      },
    },
  ]);
  const captures = await createWorkerInboxAdapter().pull(ctx(baseUrl));
  expect(captures).toEqual([
    {
      kind: "note",
      source: "shortcut",
      text: "Shared without page context.",
      capturedAt: "2026-08-04T16:00:00.000Z",
      idempotencyKey: "shared-shortcut-identity",
      upstreamId: "row-note",
    },
  ]);
});

test("ack uses the Worker row id when semantic idempotency differs", async () => {
  const { baseUrl, state } = startStub([
    {
      id: "row-with-shared-identity",
      kind: "note",
      receivedAt: "2026-08-04T16:00:00Z",
      payload: {
        text: "Delivered through Worker and iCloud.",
        idempotencyKey: "shared-shortcut-identity",
      },
    },
  ]);
  const adapter = createWorkerInboxAdapter();
  const captures = await adapter.pull(ctx(baseUrl));
  expect(captures[0]?.idempotencyKey).toBe("shared-shortcut-identity");

  await adapter.ack?.(ctx(baseUrl), captures);
  expect(state.ackBodies).toEqual([{ ids: ["row-with-shared-identity"] }]);
});

test("quarantined rows land in logs/quarantine.jsonl once, never in captures or ack", async () => {
  const { baseUrl, state } = startStub();
  const adapter = createWorkerInboxAdapter();

  const captures = await adapter.pull(ctx(baseUrl));
  expect(captures.map((c) => c.idempotencyKey)).not.toContain(
    "row-quarantined",
  );

  const qPath = join(repoRoot, "logs", "quarantine.jsonl");
  const lines = readFileSync(qPath, "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toEqual({
    at: "2026-07-02T08:00:00Z",
    from: "spam@unknown.example",
    subject: "You won",
  });

  // re-pull of the same un-acked row does not duplicate the line
  await adapter.pull(ctx(baseUrl));
  expect(readFileSync(qPath, "utf8").trim().split("\n")).toHaveLength(1);

  await adapter.ack?.(ctx(baseUrl), captures);
  expect(state.ackBodies).toHaveLength(1);
  expect(state.ackBodies[0]).toEqual({
    ids: ["row-save", "row-highlight", "row-email", "row-email-bare"],
  });
});

test("ack posts exactly the committed ids and skips empty commits", async () => {
  const { baseUrl, state } = startStub();
  const adapter = createWorkerInboxAdapter();
  const captures = await adapter.pull(ctx(baseUrl));

  await adapter.ack?.(ctx(baseUrl), captures.slice(0, 2));
  expect(state.ackBodies).toEqual([{ ids: ["row-save", "row-highlight"] }]);

  await adapter.ack?.(ctx(baseUrl), []);
  expect(state.ackBodies).toHaveLength(1); // no extra request
});

test("empty baseUrl means worker not deployed: [] with a note, no requests", async () => {
  const adapter = createWorkerInboxAdapter();
  const captures = await adapter.pull(ctx(""));
  expect(captures).toEqual([]);
  expect(adapter.note).toContain("not deployed");
});

test("Worker base URL must be an exact origin before any request", async () => {
  let called = false;
  const adapter = createWorkerInboxAdapter({
    fetchFn: async () => {
      called = true;
      return Response.json({ rows: [], nextCursor: null });
    },
  });
  for (const baseUrl of [
    "https://worker.example/subpath",
    "https://worker.example?tenant=wrong",
  ]) {
    await expect(adapter.pull(ctx(baseUrl))).rejects.toThrow(
      "origin without credentials, path, query, or fragment",
    );
  }
  expect(called).toBe(false);
});

test("401 from the worker is an AdapterHardError (bad secret is setup-broken)", async () => {
  const { baseUrl } = startStub();
  const adapter = createWorkerInboxAdapter();
  const bad = ctx(baseUrl);
  bad.config.worker.secret = "wrong-secret";

  const err = await adapter.pull(bad).catch((e) => e);
  expect(err).toBeInstanceOf(AdapterHardError);
  expect((err as AdapterHardError).adapterName).toBe("worker_inbox");

  const ackErr = await adapter
    .ack?.(bad, [
      {
        kind: "save",
        source: "shortcut",
        capturedAt: "2026-07-01T00:00:00Z",
        idempotencyKey: "row-x",
      },
    ])
    .catch((e) => e);
  expect(ackErr).toBeInstanceOf(AdapterHardError);
});

test("server errors and network failures are plain Errors, not hard errors", async () => {
  server = Bun.serve({
    port: 0,
    fetch: () => new Response("boom", { status: 500 }),
  });
  const adapter = createWorkerInboxAdapter();
  const err = await adapter
    .pull(ctx(`http://127.0.0.1:${server.port}`))
    .catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(AdapterHardError);

  // connection refused: nothing listens on port 1
  const netErr = await adapter.pull(ctx("http://127.0.0.1:1")).catch((e) => e);
  expect(netErr).toBeInstanceOf(Error);
  expect(netErr).not.toBeInstanceOf(AdapterHardError);
});

test("a hung Worker request times out instead of blocking the daemon", async () => {
  const adapter = createWorkerInboxAdapter({
    requestTimeoutMs: 20,
    fetchFn: async () => new Promise<Response>(() => {}),
  });
  const started = Date.now();
  const err = await adapter.pull(ctx("https://worker.example")).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("timed out");
  expect(Date.now() - started).toBeLessThan(500);
});

test("the request deadline also covers a response body that never closes", async () => {
  const adapter = createWorkerInboxAdapter({
    requestTimeoutMs: 20,
    fetchFn: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"rows":['));
          },
        }),
      ),
  });
  const started = Date.now();
  const err = await adapter.pull(ctx("https://worker.example")).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("timed out");
  expect(Date.now() - started).toBeLessThan(500);
});

test("one run drains a bounded capture batch and leaves later rows upstream", async () => {
  const rows = Array.from({ length: 250 }, (_, index): WorkerInboxRow => ({
    id: `row-${String(index).padStart(3, "0")}`,
    kind: "save",
    receivedAt: "2026-08-04T12:00:00.000Z",
    payload: { url: `https://example.com/${index}` },
  }));
  const requests: string[] = [];
  const adapter = createWorkerInboxAdapter({
    maxCapturesPerRun: 200,
    fetchFn: async (input) => {
      const url = new URL(String(input));
      requests.push(url.search);
      const cursor = Number(url.searchParams.get("cursor") ?? "0");
      const page = rows.slice(cursor, cursor + 50);
      const next = cursor + page.length < rows.length
        ? String(cursor + page.length)
        : null;
      return Response.json({ rows: page, nextCursor: next });
    },
  });
  const captures = await adapter.pull(ctx("https://worker.example"));
  expect(captures).toHaveLength(200);
  expect(requests).toHaveLength(4);
  expect(captures.at(-1)?.idempotencyKey).toBe("row-199");
});

test("no quarantine files are created when nothing is quarantined", async () => {
  const { baseUrl } = startStub(ROWS.slice(0, 2));
  const adapter = createWorkerInboxAdapter();
  await adapter.pull(ctx(baseUrl));
  expect(existsSync(join(repoRoot, "logs", "quarantine.jsonl"))).toBe(false);
});

test("malformed Shortcut rows stay upstream while later valid rows progress", async () => {
  const rows = [
    {
      id: "row-bad-save",
      kind: "save",
      receivedAt: "2026-08-04T12:00:00.000Z",
      payload: { title: "missing url" },
    },
    {
      id: "row-bad-highlight",
      kind: "highlight",
      receivedAt: "not-a-date",
      payload: { text: "marked" },
    },
    {
      id: "row-good",
      kind: "save",
      receivedAt: "2026-08-04T12:01:00.000Z",
      payload: { url: "https://example.com/good" },
    },
  ] as WorkerInboxRow[];
  const { baseUrl, state } = startStub(rows);
  const adapter = createWorkerInboxAdapter();
  const captures = await adapter.pull(ctx(baseUrl));

  expect(captures.map((capture) => capture.idempotencyKey)).toEqual([
    "row-good",
  ]);
  await adapter.ack?.(ctx(baseUrl), captures);
  expect(state.ackBodies).toEqual([{ ids: ["row-good"] }]);
  const bad = readFileSync(
    join(repoRoot, "logs", "bad-worker-captures.jsonl"),
    "utf8",
  );
  expect(bad).toContain("row-bad-save");
  expect(bad).toContain("row-bad-highlight");
  expect(statSync(join(repoRoot, "logs")).mode & 0o777).toBe(0o700);
  expect(
    statSync(join(repoRoot, "logs", "bad-worker-captures.jsonl")).mode &
      0o777,
  ).toBe(0o600);
  expect(
    statSync(join(repoRoot, "logs", "bad-worker-captures-seen.txt")).mode &
      0o777,
  ).toBe(0o600);
});

test("a malformed email date falls back to the trusted Worker receipt time", async () => {
  const row: WorkerInboxRow = {
    id: "row-email-bad-date",
    kind: "email",
    receivedAt: "2026-08-04T12:00:00.000Z",
    payload: {
      from: "writer@example.com",
      subject: "Bad Date header",
      date: "../../2026",
      text: "complete inline body",
    },
  };
  const adapter = createWorkerInboxAdapter({
    fetchFn: async () => Response.json({ rows: [row], nextCursor: null }),
  });
  const captures = await adapter.pull(ctx("https://worker.example"));
  expect(captures).toHaveLength(1);
  expect(captures[0]?.capturedAt).toBe("2026-08-04T12:00:00.000Z");
});

test("an oversized streamed body is bounded and cannot starve a later row", async () => {
  const rows: WorkerInboxRow[] = [
    {
      id: "row-oversized",
      kind: "email",
      receivedAt: "2026-08-04T12:00:00.000Z",
      payload: {
        from: "large@example.com",
        subject: "Too large for this installation",
        bodyKey: "email-pending/row-oversized.json",
      },
    },
    {
      id: "row-later",
      kind: "save",
      receivedAt: "2026-08-04T12:01:00.000Z",
      payload: { url: "https://example.com/later" },
    },
  ];
  let bodyRequests = 0;
  let chunksRead = 0;
  let streamCancelled = false;
  const adapter = createWorkerInboxAdapter({
    maxBodyBytesPerRun: 40,
    fetchFn: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/drain") {
        return Response.json({ rows, nextCursor: null });
      }
      if (url.pathname === "/v1/body/row-oversized") {
        bodyRequests += 1;
        let emitted = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (emitted === 4) return controller.close();
              emitted += 1;
              chunksRead += 1;
              controller.enqueue(new TextEncoder().encode("x".repeat(24)));
            },
            cancel() {
              streamCancelled = true;
            },
          }),
        );
      }
      return Response.json({ ok: true });
    },
  });

  const first = await adapter.pull(ctx("https://worker.example"));
  expect(first.map((capture) => capture.idempotencyKey)).toEqual([
    "row-later",
  ]);
  expect(bodyRequests).toBe(1);
  expect(chunksRead).toBeLessThan(4);
  expect(streamCancelled).toBe(true);
  expect(
    readFileSync(
      join(repoRoot, "logs", "oversized-worker-bodies.jsonl"),
      "utf8",
    ),
  ).toContain("row-oversized");

  const second = await adapter.pull(ctx("https://worker.example"));
  expect(second.map((capture) => capture.idempotencyKey)).toEqual([
    "row-later",
  ]);
  expect(bodyRequests).toBe(1); // local quarantine avoids repeated downloads
});
