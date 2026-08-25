export interface FakeInboxRow {
  id: string;
  kind: string;
  payload: string;
  received_at: string;
  quarantined: number;
}

export class FakeD1 {
  rows = new Map<string, FakeInboxRow>();
  allowedSenders = new Set(["writer@example.com"]);
  failInserts = false;
  failSenderLookups = false;
  beforeInsertOrIgnore?: () => Promise<void>;

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.startsWith("SELECT address")) {
            if (this.failSenderLookups) throw new Error("D1 unavailable");
            const address = String(args[0]).toLowerCase();
            return this.allowedSenders.has(address) ? { address } : null;
          }
          if (sql.startsWith("SELECT payload FROM inbox")) {
            const row = this.rows.get(String(args[0]));
            return row ? { payload: row.payload } : null;
          }
          if (
            sql.startsWith("SELECT id FROM inbox") ||
            sql.startsWith("SELECT id, payload, quarantined FROM inbox")
          ) {
            const row = this.rows.get(String(args[0]));
            return row
              ? {
                  id: row.id,
                  payload: row.payload,
                  quarantined: row.quarantined,
                }
              : null;
          }
          if (sql.startsWith("SELECT COUNT(*)")) {
            return {
              count: [...this.rows.values()].filter(
                (row) => row.quarantined === 1,
              ).length,
            };
          }
          return null;
        },
        run: async () => {
          if (sql.startsWith("INSERT INTO inbox")) {
            if (this.failInserts) throw new Error("D1 unavailable");
            this.insert(args, false);
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("INSERT OR REPLACE INTO senders")) {
            this.allowedSenders.add(String(args[0]).toLowerCase());
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("INSERT OR IGNORE INTO inbox")) {
            await this.beforeInsertOrIgnore?.();
            this.insert(args, true);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("json_extract(payload, '$.bodyKey') IS NULL")) {
            const newest = new Set(
              [...this.rows.values()]
                .filter((row) => row.quarantined === 1)
                .sort((a, b) => b.id.localeCompare(a.id))
                .slice(0, 50)
                .map((row) => row.id),
            );
            let changes = 0;
            for (const row of [...this.rows.values()]) {
              const payload = JSON.parse(row.payload) as Record<string, unknown>;
              if (
                row.quarantined === 1 &&
                payload.bodyKey === undefined &&
                !newest.has(row.id) &&
                this.rows.delete(row.id)
              ) {
                changes += 1;
              }
            }
            return { meta: { changes } };
          }
          if (sql.startsWith("DELETE FROM inbox")) {
            let changes = 0;
            for (const id of args.map(String)) {
              if (this.rows.delete(id)) changes += 1;
            }
            return { meta: { changes } };
          }
          if (sql.startsWith("UPDATE inbox SET quarantined = 0")) {
            let changes = 0;
            for (const id of args.map(String)) {
              const row = this.rows.get(id);
              if (row) {
                row.quarantined = 0;
                changes += 1;
              }
            }
            return { meta: { changes } };
          }
          if (sql.startsWith("UPDATE inbox SET payload = ?")) {
            const row = this.rows.get(String(args[1]));
            if (!row) return { meta: { changes: 0 } };
            row.payload = String(args[0]);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        all: async () => {
          if (
            sql.startsWith("SELECT id, payload, received_at FROM inbox WHERE") &&
            sql.includes("json_extract")
          ) {
            const cursor = String(args[0]);
            const limit = Number(args[1]);
            return {
              results: [...this.rows.values()]
                .filter((row) => row.kind === "email" && row.quarantined === 1)
                .filter((row) => row.id > cursor)
                .filter((row) => {
                  const payload = JSON.parse(row.payload) as Record<string, unknown>;
                  return typeof payload.bodyKey === "string";
                })
                .sort((a, b) => a.id.localeCompare(b.id))
                .slice(0, limit),
            };
          }
          if (sql.startsWith("SELECT address FROM senders")) {
            return {
              results: [...this.allowedSenders]
                .sort()
                .map((address) => ({ address })),
            };
          }
          if (sql.startsWith("SELECT id, payload")) {
            const limit = sql.includes("LIMIT ?")
              ? Number(args[0])
              : Number.POSITIVE_INFINITY;
            return {
              results: [...this.rows.values()]
                .filter((row) => row.kind === "email" && row.quarantined === 1)
                .sort((a, b) => a.id.localeCompare(b.id))
                .slice(0, limit),
            };
          }
          if (sql.startsWith("SELECT id, kind, payload")) {
            const quarantineOnly = sql.includes("quarantined = 1");
            const allowedOnly = sql.includes("quarantined = 0");
            const cursor = quarantineOnly ? "" : String(args[0]);
            const limit = Number(quarantineOnly ? args[0] : args[1]);
            return {
              results: [...this.rows.values()]
                .filter((row) => row.id > cursor)
                .filter((row) => !allowedOnly || row.quarantined === 0)
                .filter((row) => !quarantineOnly || row.quarantined === 1)
                .sort((a, b) =>
                  quarantineOnly
                    ? b.id.localeCompare(a.id)
                    : a.id.localeCompare(b.id),
                )
                .slice(0, limit),
            };
          }
          return { results: [] };
        },
      }),
    };
  }

  private insert(args: unknown[], ignoreExisting: boolean): void {
    const id = String(args[0]);
    if (ignoreExisting && this.rows.has(id)) return;
    this.rows.set(id, {
      id,
      kind: String(args[1]),
      payload: String(args[2]),
      received_at: String(args[3]),
      quarantined: Number(args[4]),
    });
    const quarantined = [...this.rows.values()]
      .filter((row) => row.quarantined === 1)
      .sort((a, b) => b.id.localeCompare(a.id));
    for (const stale of quarantined.slice(50)) this.rows.delete(stale.id);
  }
}

export class FakeR2 {
  objects = new Map<string, string>();
  getCalls = new Map<string, number>();
  failHeads = false;

  async put(key: string, value: string | ReadableStream | ArrayBuffer) {
    if (typeof value !== "string") throw new Error("fake R2 expects string data");
    this.objects.set(key, value);
  }

  async get(key: string) {
    this.getCalls.set(key, (this.getCalls.get(key) ?? 0) + 1);
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return {
      text: async () => value,
      arrayBuffer: async () => new TextEncoder().encode(value).buffer,
    };
  }

  async head(key: string) {
    if (this.failHeads) throw new Error("R2 unavailable");
    return this.objects.has(key) ? { key } : null;
  }

  async list(options: { prefix?: string; limit?: number; cursor?: string }) {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ""))
      .sort();
    const start = Number(options.cursor ?? "0");
    const limit = options.limit ?? 1000;
    const page = keys.slice(start, start + limit);
    const next = start + page.length;
    return {
      objects: page.map((key) => ({ key })),
      truncated: next < keys.length,
      cursor: next < keys.length ? String(next) : undefined,
    };
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}
