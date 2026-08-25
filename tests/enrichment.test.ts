import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../core/db.ts";
import { ingestCapture, readItem, recordFetchResult } from "../core/store.ts";
import type { WordholdConfig } from "../core/types.ts";
import {
  commitEnrichment,
  runEnrichment,
  runEnrichmentJob,
} from "../agent/enrich.ts";
import { withWriterSession } from "../core/writer.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "pt-enrich-"));
  roots.push(root);
  mkdirSync(join(root, "agent", "prompts"), { recursive: true });
  writeFileSync(
    join(root, "agent", "prompts", "enrich.md"),
    readFileSync(join(import.meta.dir, "..", "agent", "prompts", "enrich.md"), "utf8"),
  );
  writeFileSync(join(root, "agent", "tags.md"), "");
  const db = openDb(root);
  const config: WordholdConfig = {
    worker: { baseUrl: "", secret: "" },
    icloudInboxDir: "",
    readingListPlist: "",
    imessage: { recipient: "test", dryRun: true },
    enrichment: { minBodyChars: 100, maxFetchAttempts: 3 },
  };
  return { root, db, config };
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

test("enrichment keeps source text immutable and accepts only verbatim AI highlights", async () => {
  const { root, db, config } = makeRepo();
  const { item } = ingestCapture(root, db, {
    kind: "highlight",
    source: "highlight_share",
    url: "https://example.com/essay",
    title: "A Useful Essay",
    text: "The reader's exact manual highlight.",
    capturedAt: "2026-08-01T12:00:00.000Z",
  });
  const body = `${"Context matters because systems remember. ".repeat(6)}A sharp reader marks this exact sentence.`;
  recordFetchResult(root, db, item.id, { bodyMd: body }, 3);
  const before = readFileSync(join(root, item.mdPath), "utf8");
  let promptSeen = "";

  const result = await runEnrichment({
    repoRoot: root,
    db,
    config,
    now: () => "2026-08-04T12:00:00.000Z",
    runner: async (prompt) => {
      promptSeen = prompt;
      return JSON.stringify({
        summary: "Systems retain context and reward deliberate reading.",
        tags: [{ name: "memory systems", definition: "How systems retain and retrieve context." }],
        highlights: [
          "A sharp reader marks this exact sentence.",
          "A plausible sentence that was never in the source.",
        ],
      });
    },
  });

  expect(result).toMatchObject({ processed: 1, enriched: 1, errors: 0 });
  expect(promptSeen).toContain("A Useful Essay");
  expect(promptSeen).toContain(body);
  const after = readItem(root, item.mdPath);
  expect(after.body).toBe(body);
  expect(after.highlights.map((h) => [h.origin, h.text])).toEqual([
    ["manual", "The reader's exact manual highlight."],
    ["ai", "A sharp reader marks this exact sentence."],
  ]);
  expect(after.frontmatter.summary).toBe("Systems retain context and reward deliberate reading.");
  expect(after.frontmatter.tags).toEqual(["memory systems"]);
  expect(readFileSync(join(root, "agent", "tags.md"), "utf8")).toContain(
    "- memory systems: How systems retain and retrieve context.",
  );
  expect(before).toContain("The reader's exact manual highlight.");
  db.close();
});

test("body below the configured gate is flagged without calling the agent", async () => {
  const { root, db, config } = makeRepo();
  const { item } = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/thin",
    capturedAt: "2026-08-02T12:00:00.000Z",
  });
  recordFetchResult(root, db, item.id, { bodyMd: "Too little text." }, 3);
  let calls = 0;
  const result = await runEnrichment({
    repoRoot: root,
    db,
    config,
    runner: async () => {
      calls += 1;
      return "{}";
    },
  });

  expect(calls).toBe(0);
  expect(result).toMatchObject({ processed: 1, thin: 1, enriched: 0 });
  const after = readItem(root, item.mdPath);
  expect(after.body).toBe("Too little text.");
  expect(after.frontmatter.status).toBe("fetch_failed");
  expect(after.frontmatter.summary).toBeNull();
  expect(after.highlights).toEqual([]);
  db.close();
});

test("a failed old item does not starve a newer clean item", async () => {
  const { root, db, config } = makeRepo();
  const old = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/poison",
    capturedAt: "2026-07-01T12:00:00.000Z",
  }).item;
  const fresh = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/fresh",
    capturedAt: "2026-07-02T12:00:00.000Z",
  }).item;
  const body = "Substantive source text. ".repeat(10);
  recordFetchResult(root, db, old.id, { bodyMd: body }, 3);
  recordFetchResult(root, db, fresh.id, { bodyMd: body }, 3);

  const first = await runEnrichment({
    repoRoot: root,
    db,
    config,
    batchSize: 1,
    runner: async () => "not json",
  });
  expect(first.parseFailed).toBe(1);
  expect(readItem(root, old.mdPath).frontmatter.last_error).toBe(
    "enrichment_parse_failed:1",
  );

  const second = await runEnrichment({
    repoRoot: root,
    db,
    config,
    batchSize: 1,
    runner: async () =>
      JSON.stringify({
        summary: "A valid summary from the clean later item.",
        tags: [],
        highlights: [],
      }),
  });
  expect(second.enriched).toBe(1);
  expect(readItem(root, fresh.mdPath).frontmatter.status).toBe("enriched");
  expect(readItem(root, old.mdPath).frontmatter.status).toBe("has_body");
  db.close();
});

test("three failed enrichment nights retire a poison item from selection", async () => {
  const { root, db, config } = makeRepo();
  const { item } = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/always-invalid",
    capturedAt: "2026-07-01T12:00:00.000Z",
  });
  recordFetchResult(root, db, item.id, {
    bodyMd: "Substantive but persistently troublesome source text. ".repeat(5),
  }, 3);
  let calls = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await runEnrichment({
      repoRoot: root,
      db,
      config,
      batchSize: 1,
      runner: async () => {
        calls += 1;
        return "not json";
      },
    });
    expect(readItem(root, item.mdPath).frontmatter.last_error).toBe(
      `enrichment_parse_failed:${attempt}`,
    );
  }
  expect(calls).toBe(6); // one schema nudge per nightly attempt
  expect(readItem(root, item.mdPath).frontmatter.status).toBe("fetch_failed");
  const after = await runEnrichment({
    repoRoot: root,
    db,
    config,
    runner: async () => {
      calls += 1;
      return "not json";
    },
  });
  expect(after.processed).toBe(0);
  expect(calls).toBe(6);
  db.close();
});

test("the enrichment wall-clock budget defers the rest of the batch", async () => {
  const { root, db, config } = makeRepo();
  for (let index = 0; index < 2; index += 1) {
    const { item } = ingestCapture(root, db, {
      kind: "save",
      source: "shortcut",
      url: `https://example.com/budget-${index}`,
      capturedAt: `2026-07-0${index + 1}T12:00:00.000Z`,
    });
    recordFetchResult(root, db, item.id, {
      bodyMd: "Substantive source body for budget testing. ".repeat(5),
    }, 3);
  }
  const times = [0, 0, 11];
  const result = await runEnrichment({
    repoRoot: root,
    db,
    config,
    maxRunMs: 10,
    clock: () => times.shift() ?? 11,
    runner: async () =>
      JSON.stringify({ summary: "Within budget.", tags: [], highlights: [] }),
  });
  expect(result.processed).toBe(1);
  expect(
    db.query("SELECT COUNT(*) AS n FROM items WHERE status = 'has_body'").get(),
  ).toEqual({ n: 1 });
  db.close();
});

test("the production job does not hold the writer lock during inference", async () => {
  const { root, db, config } = makeRepo();
  git(root, "init", "-q");
  git(root, "config", "user.name", "Papertrail Test");
  git(root, "config", "user.email", "papertrail@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  const { item } = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/unlocked-inference",
    capturedAt: "2026-08-03T12:00:00.000Z",
  });
  recordFetchResult(root, db, item.id, {
    bodyMd: "A body long enough for inference. ".repeat(10),
  }, 3);
  git(root, "add", "--", "agent", "items");
  git(root, "commit", "-qm", "seed corpus");

  let daemonAcquired = false;
  const result = await runEnrichmentJob({
    repoRoot: root,
    db,
    config,
    batchSize: 1,
    runner: async () => {
      await withWriterSession(root, "daemon", async () => {
        daemonAcquired = true;
      });
      return JSON.stringify({
        summary: "Inference completed without excluding capture.",
        tags: [],
        highlights: [],
      });
    },
  });
  expect(daemonAcquired).toBe(true);
  expect(result.enriched).toBe(1);
  expect(git(root, "log", "-1", "--pretty=%s")).toBe("enrichment: 1 items");
  expect(
    db.query("SELECT last_error FROM source_health WHERE source = 'job:enrichment'").get(),
  ).toEqual({ last_error: null });

  const poison = ingestCapture(root, db, {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/production-parse-failure",
    capturedAt: "2026-08-04T12:00:00.000Z",
  }).item;
  recordFetchResult(root, db, poison.id, {
    bodyMd: "Another body long enough for inference. ".repeat(10),
  }, 3);
  git(root, "add", "--", poison.mdPath);
  git(root, "commit", "-qm", "seed poison item");
  const degraded = await runEnrichmentJob({
    repoRoot: root,
    db,
    config,
    batchSize: 1,
    runner: async () => "not json",
  });
  expect(degraded.parseFailed).toBe(1);
  expect(
    db.query("SELECT last_error FROM source_health WHERE source = 'job:enrichment'").get(),
  ).toEqual({ last_error: "1 enrichment item failure(s)" });
  db.close();
});

test("enrichment creates a scoped runtime commit without taking unrelated staged work", async () => {
  const root = mkdtempSync(join(tmpdir(), "pt-enrich-git-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Papertrail Test");
  git(root, "config", "user.email", "papertrail@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, "items", "2026", "08"), { recursive: true });
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(join(root, "README.md"), "baseline\n");
  writeFileSync(join(root, "agent", "tags.md"), "");
  git(root, "add", "README.md", "agent/tags.md");
  git(root, "commit", "-qm", "baseline");

  writeFileSync(join(root, "items", "2026", "08", "item.md"), "enriched\n");
  writeFileSync(join(root, "unrelated.txt"), "Reader's staged source work\n");
  git(root, "add", "unrelated.txt");

  expect(await commitEnrichment(root, 1)).toBe(true);
  expect(git(root, "log", "-1", "--pretty=%s")).toBe("enrichment: 1 items");
  expect(git(root, "show", "--pretty=", "--name-only", "HEAD")).toBe(
    "items/2026/08/item.md",
  );
  expect(git(root, "diff", "--cached", "--name-only")).toBe("unrelated.txt");
});
