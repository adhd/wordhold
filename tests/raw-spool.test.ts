import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capture } from "../core/types.ts";
import {
  listRawCaptures,
  persistRawCapture,
  removeRawCapture,
  scanRawCaptures,
} from "../daemon/raw-spool.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw spool preserves a complete capture idempotently until explicit removal", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-spool-"));
  roots.push(root);
  const capture: Capture = {
    kind: "email",
    source: "newsletter",
    url: "https://example.com/canonical",
    emailFrom: "writer@example.com",
    emailSubject: "A complete issue",
    text: "plain body\n".repeat(10_000),
    html: `<article>${"full html body".repeat(10_000)}</article>`,
    capturedAt: "2026-08-04T12:00:00.000Z",
    idempotencyKey: "worker-row-42",
  };

  const first = persistRawCapture(root, "worker_inbox", capture);
  const replay = persistRawCapture(root, "worker_inbox", {
    ...capture,
    text: "changed replay",
  });

  expect(replay.path).toBe(first.path);
  expect(listRawCaptures(root)).toEqual([first]);
  expect(first.capture.text).toBe(capture.text);
  expect(first.capture.html).toBe(capture.html);
  expect(first.adapterName).toBe("worker_inbox");
  expect(JSON.parse(readFileSync(first.path, "utf8")).version).toBe(1);

  removeRawCapture(first);
  expect(existsSync(first.path)).toBe(false);
  expect(listRawCaptures(root)).toEqual([]);
});

test("a malformed raw record does not hide an independent valid record", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-spool-corrupt-"));
  roots.push(root);
  const valid = persistRawCapture(root, "worker_inbox", {
    kind: "save",
    source: "shortcut",
    url: "https://example.com/valid-after-corruption",
    capturedAt: "2026-08-05T12:00:00.000Z",
  });
  const corruptPath = join(
    root,
    "inbox",
    "raw",
    `${"f".repeat(64)}.json`,
  );
  const corruptBytes = "{ definitely not valid JSON\n";
  writeFileSync(corruptPath, corruptBytes);

  const scan = scanRawCaptures(root);

  expect(scan.entries).toEqual([valid]);
  expect(scan.issues).toEqual([
    {
      id: "f".repeat(64),
      path: corruptPath,
      reason: "invalid JSON",
    },
  ]);
  expect(readFileSync(corruptPath, "utf8")).toBe(corruptBytes);
});
