import { expect, test } from "bun:test";
import { handleEmail } from "../worker/src/email.ts";
import { handleFetch } from "../worker/src/index.ts";
import { FakeD1, FakeR2 } from "./helpers/worker-fakes.ts";

test(
  "a 20 MiB newsletter body is retained completely outside the D1 row",
  async () => {
    const body = "newsletter-body-line\n".repeat(
      Math.ceil((20 * 1024 * 1024) / "newsletter-body-line\n".length),
    );
    const raw = [
      "From: Writer <writer@example.com>",
      "To: papertrail@example.com",
      "Subject: Twenty megabyte issue",
      "Content-Type: text/plain; charset=utf-8",
      "List-Post: <https://example.com/issues/twenty>",
      "",
      body,
    ].join("\r\n");
    const db = new FakeD1();
    const bodies = new FakeR2();

    await handleEmail(
      { from: "writer@example.com", headers: new Headers(), raw },
      db as never,
      bodies as never,
    );

    expect(db.rows.size).toBe(1);
    const payload = JSON.parse([...db.rows.values()][0]!.payload) as Record<string, unknown>;
    expect(payload.listPost).toBe("<https://example.com/issues/twenty>");
    expect(String(payload.bodyKey)).toStartWith("email-pending/");
    expect(payload.text).toBeUndefined();
    const pending = JSON.parse(
      bodies.objects.get(String(payload.bodyKey)) ?? "null",
    ) as { body: { text: string; html?: string }; row: { id: string } };
    expect(pending.row.id).toBe([...db.rows.keys()][0]);
    expect(pending.body.text).toBe(body);
    expect(pending.body.text.length).toBeGreaterThanOrEqual(20 * 1024 * 1024);
  },
  20_000,
);

test("a D1 outage leaves a recoverable R2 record instead of losing the email", async () => {
  const db = new FakeD1();
  db.failInserts = true;
  const bodies = new FakeR2();

  await handleEmail(
    { from: "writer@example.com", headers: new Headers(), raw: "unused" },
    db as never,
    bodies as never,
    {
      now: () => "2026-08-04T12:00:00.000Z",
      parse: async () =>
        ({
          from: { address: "writer@example.com" },
          subject: "D1 outage issue",
          text: "complete body",
          html: "<p>complete body</p>",
          headers: [],
        }) as never,
    },
  );

  expect(db.rows.size).toBe(0);
  const keys = [...bodies.objects.keys()].sort();
  expect(keys).toHaveLength(1);
  expect(keys[0]).toStartWith("email-pending/");
  const pending = JSON.parse(bodies.objects.get(keys[0]!)!) as {
    row: { payload: { bodyKey: string } };
    body: { text: string; html: string };
  };
  expect(pending.row.payload.bodyKey).toBe(keys[0]);
  expect(pending.body.text).toBe("complete body");
});

test("an allowlisted header From cannot override an untrusted envelope sender", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  await handleEmail(
    {
      from: "attacker@untrusted.example",
      headers: new Headers(),
      raw: "unused",
    },
    db as never,
    bodies as never,
    {
      parse: async () =>
        ({
          from: { address: "writer@example.com" },
          subject: "Spoofed sender",
          text: "hostile body",
          headers: [],
        }) as never,
    },
  );
  const row = [...db.rows.values()][0]!;
  expect(row.quarantined).toBe(1);
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  expect(payload.from).toBe("attacker@untrusted.example");
  expect(payload.headerFrom).toBe("writer@example.com");
});

test("oversized unknown mail is metadata-only and cannot enter the corpus after allow", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  await handleEmail(
    {
      from: "unknown@example.com",
      headers: new Headers({ subject: "Large stranger" }),
      raw: "x".repeat(2 * 1024 * 1024),
    },
    db as never,
    bodies as never,
  );

  const row = [...db.rows.values()][0]!;
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  expect(row.quarantined).toBe(1);
  expect(payload.bodyKey).toBeUndefined();
  expect(payload.error).toBe("quarantine_body_too_large");
  expect(
    [...bodies.objects.keys()].filter((key) => key.startsWith("email-pending/")),
  ).toEqual([]);

  await handleFetch(
    new Request("https://worker.example/v1/allow", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ address: "unknown@example.com" }),
    }),
    { INBOX: db, BODIES: bodies, SECRET: "secret" } as never,
  );
  expect(row.quarantined).toBe(1);
});

test("concurrent unknown mail stays in one bounded D1 quarantine", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  await Promise.all(
    Array.from({ length: 100 }, (_, index) => handleEmail(
      {
        from: `unknown-${index}@example.com`,
        headers: new Headers(),
        raw: "small",
      },
      db as never,
      bodies as never,
      {
        parse: async () =>
          ({
            subject: `Unknown ${index}`,
            text: `body ${index}`,
            headers: [],
          }) as never,
      },
    )),
  );
  expect(db.rows.size).toBe(50);
  expect(bodies.objects.size).toBe(0);
});

test("a D1 outage while quarantining cannot orphan an R2 body", async () => {
  const db = new FakeD1();
  db.failInserts = true;
  const bodies = new FakeR2();
  await handleEmail(
    {
      from: "unknown@example.com",
      headers: new Headers(),
      raw: "small",
    },
    db as never,
    bodies as never,
    {
      parse: async () =>
        ({ subject: "Unknown", text: "small body", headers: [] }) as never,
    },
  );
  expect(db.rows.size).toBe(0);
  expect(bodies.objects.size).toBe(0);
});

test("a small quarantined message becomes drainable intact after allowlisting", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  await handleEmail(
    {
      from: "new-writer@example.com",
      headers: new Headers(),
      raw: "small",
    },
    db as never,
    bodies as never,
    {
      parse: async () =>
        ({
          subject: "Confirmation",
          text: "confirm at https://example.com/confirm",
          headers: [],
        }) as never,
    },
  );
  const env = { INBOX: db, BODIES: bodies, SECRET: "secret" } as never;
  await handleFetch(
    new Request("https://worker.example/v1/allow", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ address: "new-writer@example.com" }),
    }),
    env,
  );
  const drained = await handleFetch(
    new Request("https://worker.example/v1/drain", {
      headers: { authorization: "Bearer secret" },
    }),
    env,
  );
  const page = (await drained.json()) as {
    rows: Array<{ payload: { text?: string; bodyKey?: string } }>;
  };
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0]?.payload.text).toBe(
    "confirm at https://example.com/confirm",
  );
  expect(page.rows[0]?.payload.bodyKey).toBeUndefined();
  expect(
    [...bodies.objects.keys()].filter((key) => key.startsWith("email-pending/")),
  ).toEqual([]);
});

test("an R2 allow marker preserves a known large sender during D1 lookup failure", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  const env = { INBOX: db, BODIES: bodies, SECRET: "secret" } as never;
  await handleFetch(
    new Request("https://worker.example/v1/allow", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ address: "known@example.com" }),
    }),
    env,
  );
  db.failSenderLookups = true;
  await handleEmail(
    {
      from: "known@example.com",
      headers: new Headers(),
      raw: "unused",
    },
    db as never,
    bodies as never,
    {
      parse: async () =>
        ({
          subject: "Known large issue",
          text: "x".repeat(2 * 1024 * 1024),
          headers: [],
        }) as never,
    },
  );
  const pending = [...bodies.objects.keys()].filter((key) =>
    key.startsWith("email-pending/"),
  );
  expect(pending).toHaveLength(1);
  const stored = JSON.parse(bodies.objects.get(pending[0]!)!) as {
    body: { text: string };
  };
  expect(stored.body.text.length).toBe(2 * 1024 * 1024);
});

test("indeterminate sender authorization fails instead of lossy quarantine", async () => {
  const db = new FakeD1();
  db.failSenderLookups = true;
  const bodies = new FakeR2();
  await expect(
    handleEmail(
      {
        from: "maybe-known@example.com",
        headers: new Headers(),
        raw: "x".repeat(2 * 1024 * 1024),
      },
      db as never,
      bodies as never,
    ),
  ).rejects.toThrow("sender authorization unavailable");
  expect(db.rows.size).toBe(0);
  expect(bodies.objects.size).toBe(0);
});

test("an unavailable sender marker is indeterminate after a D1 miss", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  bodies.failHeads = true;
  await expect(
    handleEmail(
      {
        from: "partially-allowed@example.com",
        headers: new Headers(),
        raw: "small",
      },
      db as never,
      bodies as never,
    ),
  ).rejects.toThrow("sender authorization unavailable");
  expect(db.rows.size).toBe(0);
  expect(bodies.objects.size).toBe(0);
});
