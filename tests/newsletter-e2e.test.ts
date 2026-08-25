import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../core/db.ts";
import { readItem } from "../core/store.ts";
import type { WordholdConfig } from "../core/types.ts";
import { createWorkerInboxAdapter } from "../daemon/adapters/worker-inbox.ts";
import { runDaemonOnce } from "../daemon/main.ts";
import { handleEmail } from "../worker/src/email.ts";
import { handleFetch } from "../worker/src/index.ts";
import { FakeD1, FakeR2 } from "./helpers/worker-fakes.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

test(
  "a 20 MiB newsletter survives Worker-to-canonical lifecycle with its web URL",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pt-newsletter-e2e-"));
    roots.push(root);
    git(root, "init", "-q");
    git(root, "config", "user.name", "Papertrail Test");
    git(root, "config", "user.email", "papertrail@example.invalid");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, "README.md"), "test corpus\n");
    writeFileSync(join(root, ".gitignore"), "papertrail.db*\ninbox/\nlogs/*.log\n");
    git(root, "add", "README.md", ".gitignore");
    git(root, "commit", "-qm", "baseline");

    const line = "complete-newsletter-body-line\n";
    const body = line.repeat(Math.ceil((20 * 1024 * 1024) / line.length));
    const raw = [
      "From: Writer <writer@example.com>",
      "To: papertrail@example.com",
      "Subject: Complete large issue",
      "Date: Tue, 04 Aug 2026 12:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "List-Post: <https://newsletter.example/issues/complete-large>",
      "",
      body,
    ].join("\r\n");
    const inbox = new FakeD1();
    const bodies = new FakeR2();
    await handleEmail(
      { from: "writer@example.com", headers: new Headers(), raw },
      inbox as never,
      bodies as never,
    );
    expect(inbox.rows.size).toBe(1);

    const env = { INBOX: inbox, BODIES: bodies, SECRET: "secret" } as never;
    const workerFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      return handleFetch(request, env);
    };
    const config: WordholdConfig = {
      worker: { baseUrl: "https://worker.example", secret: "secret" },
      icloudInboxDir: "",
      readingListPlist: "",
      imessage: { recipient: "test", dryRun: true },
      enrichment: { minBodyChars: 100, maxFetchAttempts: 3 },
    };
    const result = await runDaemonOnce({
      repoRoot: root,
      config,
      adapters: [createWorkerInboxAdapter({ fetchFn: workerFetch })],
    });
    expect(result).toMatchObject({ pulled: 1, processed: 1, acked: 1, errors: 0 });

    const db = openDb(root);
    const item = db.query("SELECT url, md_path, status FROM items").get() as {
      url: string;
      md_path: string;
      status: string;
    };
    expect(item.url).toBe("https://newsletter.example/issues/complete-large");
    expect(item.status).toBe("has_body");
    const canonical = readItem(root, item.md_path);
    expect(canonical.body.length).toBeGreaterThanOrEqual(20 * 1024 * 1024);
    expect(canonical.body).toStartWith("complete-newsletter-body-line");
    expect(canonical.frontmatter.url).toBe(
      "https://newsletter.example/issues/complete-large",
    );
    db.close();
    expect(inbox.rows.size).toBe(0);
    expect([...bodies.objects.keys()].filter((key) => key.startsWith("email-bodies/"))).toEqual([]);
  },
  30_000,
);

test("oversized quarantine metadata cannot block a later allowed capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-newsletter-metadata-"));
  roots.push(root);
  const inbox = new FakeD1();
  const bodies = new FakeR2();
  await handleEmail(
    {
      from: "unknown@example.com",
      headers: new Headers(),
      raw: "unused",
    },
    inbox as never,
    bodies as never,
    {
      parse: async () =>
        ({
          from: { address: "unknown@example.com" },
          subject: "x".repeat(3 * 1024 * 1024),
          text: "quarantined body",
          headers: [],
        }) as never,
    },
  );
  const env = { INBOX: inbox, BODIES: bodies, SECRET: "secret" } as never;
  const workerFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handleFetch(request, env);
  };
  const saved = await workerFetch("https://worker.example/v1/save", {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ url: "https://example.com/allowed" }),
  });
  expect(saved.status).toBe(200);

  const adapter = createWorkerInboxAdapter({ fetchFn: workerFetch });
  const captures = await adapter.pull({
    repoRoot: root,
    config: {
      worker: { baseUrl: "https://worker.example", secret: "secret" },
      icloudInboxDir: "",
      readingListPlist: "",
      imessage: { recipient: "", dryRun: true },
      enrichment: { minBodyChars: 100, maxFetchAttempts: 3 },
    },
  });
  expect(captures.map((capture) => capture.url)).toEqual([
    "https://example.com/allowed",
  ]);
});
