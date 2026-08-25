import { expect, test } from "bun:test";
import { handleFetch } from "../worker/src/index.ts";
import { FakeD1, FakeR2 } from "./helpers/worker-fakes.ts";

test("the minimal URL save returns only a durable inbox receipt", async () => {
  const db = new FakeD1();
  const response = await handleFetch(
    new Request("https://worker.example/v1/save", {
      method: "POST",
      headers: {
        authorization: "Bearer phone-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: "https://example.com/one-url" }),
    }),
    {
      INBOX: db,
      BODIES: new FakeR2(),
      SECRET: "admin-secret",
      CAPTURE_SECRET: "phone-secret",
    } as never,
  );

  expect(response.status).toBe(200);
  const receipt = (await response.json()) as { id: string };
  expect(receipt).toEqual({ id: expect.stringMatching(/^in_/) });
  expect(db.rows.get(receipt.id)).toMatchObject({
    id: receipt.id,
    kind: "save",
    quarantined: 0,
  });
  expect(JSON.parse(db.rows.get(receipt.id)!.payload)).toEqual({
    url: "https://example.com/one-url",
  });
});

test("a failed inbox insert cannot return a save receipt", async () => {
  const db = new FakeD1();
  db.failInserts = true;

  await expect(handleFetch(
    new Request("https://worker.example/v1/save", {
      method: "POST",
      headers: {
        authorization: "Bearer phone-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: "https://example.com/not-durable" }),
    }),
    {
      INBOX: db,
      BODIES: new FakeR2(),
      SECRET: "admin-secret",
      CAPTURE_SECRET: "phone-secret",
    } as never,
  )).rejects.toThrow("D1 unavailable");
  expect(db.rows.size).toBe(0);
});

test("capture-only credentials can enqueue but cannot read or administer", async () => {
  const db = new FakeD1();
  const env = {
    INBOX: db,
    BODIES: new FakeR2(),
    SECRET: "admin-secret",
    CAPTURE_SECRET: "phone-secret",
  } as never;
  const captureAuth = { authorization: "Bearer phone-secret" };

  const save = await handleFetch(
    new Request("https://worker.example/v1/save", {
      method: "POST",
      headers: { ...captureAuth, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/least-privilege" }),
    }),
    env,
  );
  expect(save.status).toBe(200);

  for (const [method, path, body] of [
    ["GET", "/v1/drain", undefined],
    ["GET", "/v1/body/in_any", undefined],
    ["POST", "/v1/ack", { ids: [] }],
    ["POST", "/v1/allow", { address: "sender@example.com" }],
    ["POST", "/v1/sync-senders", {}],
  ] as const) {
    const response = await handleFetch(
      new Request(`https://worker.example${path}`, {
        method,
        headers: { ...captureAuth, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env,
    );
    expect(response.status).toBe(403);
  }

  const adminDrain = await handleFetch(
    new Request("https://worker.example/v1/drain", {
      headers: { authorization: "Bearer admin-secret" },
    }),
    env,
  );
  expect(adminDrain.status).toBe(200);
});

test("the unified capture route durably queues an honest text-only note", async () => {
  const db = new FakeD1();
  const env = {
    INBOX: db,
    BODIES: new FakeR2(),
    SECRET: "admin-secret",
    CAPTURE_SECRET: "phone-secret",
  } as never;
  const response = await handleFetch(
    new Request("https://worker.example/v1/capture", {
      method: "POST",
      headers: {
        authorization: "Bearer phone-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "note",
        text: "A text share with no page context.",
        capturedAt: "2026-08-04T16:00:00Z",
        idempotencyKey: "shared-shortcut-identity",
      }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  const receipt = (await response.json()) as { id: string };
  expect(receipt.id).toMatch(/^in_/);

  const drain = await handleFetch(
    new Request("https://worker.example/v1/drain", {
      headers: { authorization: "Bearer admin-secret" },
    }),
    env,
  );
  const page = (await drain.json()) as {
    rows: Array<{ kind: string; payload: Record<string, unknown> }>;
  };
  expect(page.rows).toEqual([
    expect.objectContaining({
      kind: "note",
      payload: {
        text: "A text share with no page context.",
        capturedAt: "2026-08-04T16:00:00.000Z",
        idempotencyKey: "shared-shortcut-identity",
      },
    }),
  ]);
});

test("a repeated capture idempotency identity is one durable Worker row", async () => {
  const db = new FakeD1();
  const env = {
    INBOX: db,
    BODIES: new FakeR2(),
    SECRET: "admin-secret",
    CAPTURE_SECRET: "phone-secret",
  } as never;
  const request = () =>
    handleFetch(
      new Request("https://worker.example/v1/capture", {
        method: "POST",
        headers: {
          authorization: "Bearer phone-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "save",
          url: "https://example.com/replayed",
          idempotencyKey: "shortcut-file-123",
        }),
      }),
      env,
    );

  const first = (await (await request()).json()) as { id: string };
  const second = (await (await request()).json()) as { id: string };
  expect(second.id).toBe(first.id);
  expect(db.rows.size).toBe(1);
});

test("capture routes reject malformed fields before queueing", async () => {
  const db = new FakeD1();
  const env = {
    INBOX: db,
    BODIES: new FakeR2(),
    SECRET: "secret",
  } as never;
  const invalid = [
    ["save", { title: "No URL" }],
    ["save", { url: "http://127.0.0.1/private" }],
    ["save", { url: "https://example.com", title: 42 }],
    ["save", { url: "https://example.com", capturedAt: "../../2026" }],
    ["save", { url: "https://example.com", capturedAt: "01/02/2026" }],
    ["save", { url: "https://example.com", title: "x".repeat(3_000) }],
    ["highlight", { url: "https://example.com" }],
  ] as const;

  for (const [kind, body] of invalid) {
    const response = await handleFetch(
      new Request(`https://worker.example/v1/${kind}`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(response.status).toBe(400);
  }
  expect(db.rows.size).toBe(0);
});

test("capture acceptance is bounded after JSON escaping, not before", async () => {
  const db = new FakeD1();
  const env = {
    INBOX: db,
    BODIES: new FakeR2(),
    SECRET: "secret",
  } as never;
  const post = (text: string) =>
    handleFetch(
      new Request("https://worker.example/v1/highlight", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ text }),
      }),
      env,
    );

  expect((await post("\\".repeat(24 * 1024))).status).toBe(400);
  const accepted = "\\".repeat(10 * 1024);
  expect((await post(accepted)).status).toBe(200);
  const drain = await handleFetch(
    new Request("https://worker.example/v1/drain", {
      headers: { authorization: "Bearer secret" },
    }),
    env,
  );
  const page = (await drain.json()) as {
    rows: Array<{ quarantined: boolean; payload: { text: string } }>;
  };
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0]?.quarantined).toBe(false);
  expect(page.rows[0]?.payload.text).toBe(accepted);
});

test("capture request bytes are bounded before JSON parsing", async () => {
  const db = new FakeD1();
  const env = {
    INBOX: db,
    BODIES: new FakeR2(),
    SECRET: "admin-secret",
    CAPTURE_SECRET: "phone-secret",
  } as never;
  const raw = JSON.stringify({
    kind: "note",
    text: "small honest note",
    idempotencyKey: "raw-request-bound",
  }) + " ".repeat(41 * 1024);
  const response = await handleFetch(
    new Request("https://worker.example/v1/capture", {
      method: "POST",
      headers: {
        authorization: "Bearer phone-secret",
        "content-type": "application/json",
      },
      body: raw,
    }),
    env,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "capture request is too large" });
  expect(db.rows.size).toBe(0);
});

test("Worker refuses a request whose exact persisted capture cannot be drained", async () => {
  const db = new FakeD1();
  const env = {
    INBOX: db,
    BODIES: new FakeR2(),
    SECRET: "admin-secret",
    CAPTURE_SECRET: "phone-secret",
  } as never;
  const body = {
    url: `https://example.com/${"u".repeat(7_000)}`,
    title: "t".repeat(2_000),
    text: String.fromCharCode(92).repeat(15_676),
    idempotencyKey: "k".repeat(500),
    capturedAt: "2026-08-04T17:00:00Z",
  };
  expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBe(40_959);

  const response = await handleFetch(
    new Request("https://worker.example/v1/highlight", {
      method: "POST",
      headers: {
        authorization: "Bearer phone-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "serialized capture payload is too large",
  });
  expect(db.rows.size).toBe(0);
});

test("Worker accepts the exact drain payload boundary", async () => {
  const db = new FakeD1();
  const env = {
    INBOX: db,
    BODIES: new FakeR2(),
    SECRET: "admin-secret",
    CAPTURE_SECRET: "phone-secret",
  } as never;
  const body = {
    url: `https://example.com/${"u".repeat(7_000)}`,
    title: "t".repeat(2_001),
    text: String.fromCharCode(92).repeat(15_674),
    idempotencyKey: "k".repeat(500),
    capturedAt: "2026-08-04T17:00:00Z",
  };
  const canonical = {
    url: body.url,
    title: body.title,
    text: body.text,
    capturedAt: "2026-08-04T17:00:00.000Z",
    idempotencyKey: body.idempotencyKey,
  };
  expect(new TextEncoder().encode(JSON.stringify(canonical)).byteLength).toBe(40_960);

  const response = await handleFetch(
    new Request("https://worker.example/v1/highlight", {
      method: "POST",
      headers: {
        authorization: "Bearer phone-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
  );

  expect(response.status).toBe(200);
  const drain = await handleFetch(
    new Request("https://worker.example/v1/drain", {
      headers: { authorization: "Bearer admin-secret" },
    }),
    env,
  );
  const page = await drain.json() as { rows: Array<{ quarantined: boolean }> };
  expect(page.rows).toEqual([expect.objectContaining({ quarantined: false })]);
});

test("write-ahead R2 email promotes, drains, serves, and acks after D1 interruption", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  const id = "in_recovered";
  const bodyKey = `email-pending/${id}.json`;
  await bodies.put(
    bodyKey,
    JSON.stringify({
      row: {
        id,
        kind: "email",
        payload: {
          from: "writer@example.com",
          subject: "Recovered issue",
          bodyKey,
        },
        receivedAt: "2026-08-04T12:00:00.000Z",
        quarantined: 0,
      },
      body: { text: "complete recovered body" },
    }),
  );
  const env = { INBOX: db, BODIES: bodies, SECRET: "secret" } as never;
  const auth = { authorization: "Bearer secret" };

  const drain = await handleFetch(
    new Request("https://worker.example/v1/drain?limit=50", { headers: auth }),
    env,
  );
  expect(drain.status).toBe(200);
  const page = (await drain.json()) as { rows: Array<{ id: string }> };
  expect(page.rows.map((row) => row.id)).toEqual([id]);
  expect(bodies.objects.has(bodyKey)).toBe(true);

  const body = await handleFetch(
    new Request(`https://worker.example/v1/body/${id}`, { headers: auth }),
    env,
  );
  expect(await body.json()).toEqual({ text: "complete recovered body" });

  const ack = await handleFetch(
    new Request("https://worker.example/v1/ack", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    }),
    env,
  );
  expect(await ack.json()).toEqual({ deleted: 1 });
  expect(db.rows.size).toBe(0);
  expect(bodies.objects.has(bodyKey)).toBe(false);
  expect(bodies.objects.has(`email-acked/${id}`)).toBe(true);
});

test("drain never downloads an already-indexed large pending body", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  const id = "in_indexed";
  const bodyKey = `email-pending/${id}.json`;
  const row = {
    id,
    kind: "email",
    payload: JSON.stringify({ from: "writer@example.com", bodyKey }),
    received_at: "2026-08-04T12:00:00.000Z",
    quarantined: 0,
  };
  db.rows.set(id, row);
  await bodies.put(
    bodyKey,
    JSON.stringify({ row, body: { text: "x".repeat(1_000_000) } }),
  );
  const response = await handleFetch(
    new Request("https://worker.example/v1/drain", {
      headers: { authorization: "Bearer secret" },
    }),
    { INBOX: db, BODIES: bodies, SECRET: "secret" } as never,
  );
  expect(response.status).toBe(200);
  expect(bodies.getCalls.get(bodyKey) ?? 0).toBe(0);
});

test("an acknowledgement tombstone prevents pending-row resurrection", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  const id = "in_acking";
  const bodyKey = `email-pending/${id}.json`;
  await bodies.put(
    bodyKey,
    JSON.stringify({
      row: {
        id,
        kind: "email",
        payload: { from: "writer@example.com", bodyKey },
        receivedAt: "2026-08-04T12:00:00.000Z",
        quarantined: 0,
      },
      body: { text: "complete body" },
    }),
  );
  await bodies.put(`email-acked/${id}`, "");
  const response = await handleFetch(
    new Request("https://worker.example/v1/drain", {
      headers: { authorization: "Bearer secret" },
    }),
    { INBOX: db, BODIES: bodies, SECRET: "secret" } as never,
  );
  const page = (await response.json()) as { rows: unknown[] };
  expect(page.rows).toEqual([]);
  expect(db.rows.size).toBe(0);
  expect(bodies.getCalls.get(bodyKey) ?? 0).toBe(0);
});

test("promotion retracts a row when ack starts immediately before its insert", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  const id = "in_racing";
  const bodyKey = `email-pending/${id}.json`;
  await bodies.put(
    bodyKey,
    JSON.stringify({
      row: {
        id,
        kind: "email",
        payload: { from: "writer@example.com", bodyKey },
        receivedAt: "2026-08-04T12:00:00.000Z",
        quarantined: 0,
      },
      body: { text: "complete body" },
    }),
  );
  db.beforeInsertOrIgnore = () => bodies.put(`email-acked/${id}`, "");

  const response = await handleFetch(
    new Request("https://worker.example/v1/drain", {
      headers: { authorization: "Bearer secret" },
    }),
    { INBOX: db, BODIES: bodies, SECRET: "secret" } as never,
  );
  const page = (await response.json()) as { rows: unknown[] };
  expect(page.rows).toEqual([]);
  expect(db.rows.size).toBe(0);
});

test("quarantined rows are visible but cannot block the allowed drain cursor", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  for (let index = 0; index < 60; index += 1) {
    const id = `in_${String(index).padStart(3, "0")}`;
    db.rows.set(id, {
      id,
      kind: "email",
      payload: JSON.stringify({ from: `sender-${index}@example.com` }),
      received_at: "2026-08-04T12:00:00.000Z",
      quarantined: 1,
    });
  }
  db.rows.set("in_z_allowed", {
    id: "in_z_allowed",
    kind: "save",
    payload: JSON.stringify({ url: "https://example.com/allowed" }),
    received_at: "2026-08-04T12:01:00.000Z",
    quarantined: 0,
  });
  const response = await handleFetch(
    new Request("https://worker.example/v1/drain?limit=50", {
      headers: { authorization: "Bearer secret" },
    }),
    { INBOX: db, BODIES: bodies, SECRET: "secret" } as never,
  );
  const page = (await response.json()) as {
    rows: Array<{ id: string }>;
    quarantinedRows: Array<{ id: string }>;
  };
  expect(page.rows.map((row) => row.id)).toEqual(["in_z_allowed"]);
  expect(page.quarantinedRows).toHaveLength(50);
});

test("recovery rotates past 200 indexed pending objects", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  for (let index = 0; index < 200; index += 1) {
    const id = `in_a_${String(index).padStart(3, "0")}`;
    const bodyKey = `email-pending/${id}.json`;
    const row = {
      id,
      kind: "email",
      payload: JSON.stringify({ from: "indexed@example.com", bodyKey }),
      received_at: "2026-08-04T12:00:00.000Z",
      quarantined: 1,
    };
    db.rows.set(id, row);
    await bodies.put(bodyKey, JSON.stringify({ row, body: { text: "indexed" } }));
  }
  const missingId = "in_z_missing";
  const missingKey = `email-pending/${missingId}.json`;
  await bodies.put(
    missingKey,
    JSON.stringify({
      row: {
        id: missingId,
        kind: "email",
        payload: { from: "recovered@example.com", bodyKey: missingKey },
        receivedAt: "2026-08-04T12:01:00.000Z",
        quarantined: 0,
      },
      body: { text: "recover me" },
    }),
  );
  const env = { INBOX: db, BODIES: bodies, SECRET: "secret" } as never;
  const request = () =>
    handleFetch(
      new Request("https://worker.example/v1/drain?limit=1", {
        headers: { authorization: "Bearer secret" },
      }),
      env,
    );
  await request();
  expect(db.rows.has(missingId)).toBe(false);
  for (let pass = 0; pass < 50 && !db.rows.has(missingId); pass += 1) {
    await request();
  }
  expect(db.rows.has(missingId)).toBe(true);
});

test("upgrade recovery tombstones legacy quarantine R2 before pruning to 50", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  for (let index = 0; index < 55; index += 1) {
    const id = `in_legacy_${String(index).padStart(3, "0")}`;
    const bodyKey = `email-pending/${id}.json`;
    const row = {
      id,
      kind: "email" as const,
      payload: {
        from: `unknown-${index}@example.com`,
        subject: `Legacy ${index}`,
        bodyKey,
      },
      receivedAt: "2026-08-04T12:00:00.000Z",
      quarantined: 1 as const,
    };
    db.rows.set(id, {
      id,
      kind: "email",
      payload: JSON.stringify(row.payload),
      received_at: row.receivedAt,
      quarantined: 1,
    });
    await bodies.put(bodyKey, JSON.stringify({ row, body: { text: "legacy" } }));
  }
  const env = { INBOX: db, BODIES: bodies, SECRET: "secret" } as never;
  for (let pass = 0; pass < 12; pass += 1) {
    await handleFetch(
      new Request("https://worker.example/v1/drain?limit=1", {
        headers: { authorization: "Bearer secret" },
      }),
      env,
    );
  }

  expect(
    [...bodies.objects.keys()].filter((key) => key.startsWith("email-pending/")),
  ).toEqual([]);
  expect(
    [...bodies.objects.keys()].filter((key) => key.startsWith("email-acked/")),
  ).toHaveLength(55);
  expect(db.rows.size).toBe(50);
  for (const row of db.rows.values()) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload.bodyKey).toBeUndefined();
    expect(payload.error).toBe("legacy_quarantine_requires_resend");
  }
});

test("upgrade recovery completes after a tombstone-before-delete interruption", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  const id = "in_legacy_interrupted";
  const bodyKey = `email-pending/${id}.json`;
  const payload = {
    from: "unknown@example.com",
    subject: "Interrupted legacy cleanup",
    bodyKey,
  };
  db.rows.set(id, {
    id,
    kind: "email",
    payload: JSON.stringify(payload),
    received_at: "2026-08-04T12:00:00.000Z",
    quarantined: 1,
  });
  await bodies.put(
    bodyKey,
    JSON.stringify({
      row: {
        id,
        kind: "email",
        payload,
        receivedAt: "2026-08-04T12:00:00.000Z",
        quarantined: 1,
      },
      body: { text: "legacy" },
    }),
  );
  await bodies.put(`email-acked/${id}`, "");

  await handleFetch(
    new Request("https://worker.example/v1/drain?limit=1", {
      headers: { authorization: "Bearer secret" },
    }),
    { INBOX: db, BODIES: bodies, SECRET: "secret" } as never,
  );

  expect(bodies.objects.has(bodyKey)).toBe(false);
  const migrated = JSON.parse(db.rows.get(id)!.payload) as Record<string, unknown>;
  expect(migrated.bodyKey).toBeUndefined();
  expect(migrated.error).toBe("legacy_quarantine_requires_resend");
});

test("upgrade sweep retires missing legacy bodies and converges to 50 rows", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  for (let index = 0; index < 205; index += 1) {
    const id = `in_missing_${String(index).padStart(3, "0")}`;
    const bodyKey = `email-pending/${id}.json`;
    const payload = {
      from: `missing-${index}@example.com`,
      subject: `Missing legacy ${index}`,
      bodyKey,
    };
    db.rows.set(id, {
      id,
      kind: "email",
      payload: JSON.stringify(payload),
      received_at: "2026-08-04T12:00:00.000Z",
      quarantined: 1,
    });
    if (index < 2) {
      await bodies.put(
        bodyKey,
        JSON.stringify({
          row: {
            id,
            kind: "email",
            payload,
            receivedAt: "2026-08-04T12:00:00.000Z",
            quarantined: 1,
          },
          body: { text: "present legacy body" },
        }),
      );
    }
  }
  const env = { INBOX: db, BODIES: bodies, SECRET: "secret" } as never;
  for (let pass = 0; pass < 45; pass += 1) {
    await handleFetch(
      new Request("https://worker.example/v1/drain?limit=1", {
        headers: { authorization: "Bearer secret" },
      }),
      env,
    );
  }

  expect(db.rows.size).toBe(50);
  for (const row of db.rows.values()) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload.bodyKey).toBeUndefined();
    expect(payload.error).toBe("legacy_quarantine_requires_resend");
  }
});

test("allowlisting does not release a legacy row with a missing body", async () => {
  const db = new FakeD1();
  const bodies = new FakeR2();
  const id = "in_missing_allow";
  db.rows.set(id, {
    id,
    kind: "email",
    payload: JSON.stringify({
      from: "missing@example.com",
      subject: "Missing body",
      bodyKey: `email-pending/${id}.json`,
    }),
    received_at: "2026-08-04T12:00:00.000Z",
    quarantined: 1,
  });
  const response = await handleFetch(
    new Request("https://worker.example/v1/allow", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ address: "missing@example.com" }),
    }),
    { INBOX: db, BODIES: bodies, SECRET: "secret" } as never,
  );

  expect(await response.json()).toEqual({
    address: "missing@example.com",
    unquarantined: 0,
  });
  expect(db.rows.get(id)?.quarantined).toBe(1);
  const payload = JSON.parse(db.rows.get(id)!.payload) as Record<string, unknown>;
  expect(payload.bodyKey).toBeUndefined();
  expect(payload.error).toBe("legacy_quarantine_requires_resend");
});

test("sender sync mirrors existing D1 allowlist entries into R2", async () => {
  const db = new FakeD1();
  db.allowedSenders.add("second@example.com");
  const bodies = new FakeR2();
  const response = await handleFetch(
    new Request("https://worker.example/v1/sync-senders", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    }),
    { INBOX: db, BODIES: bodies, SECRET: "secret" } as never,
  );
  expect(await response.json()).toEqual({ synced: 2 });
  expect(
    [...bodies.objects.keys()].filter((key) => key.startsWith("sender-allowed/")),
  ).toHaveLength(2);
});
