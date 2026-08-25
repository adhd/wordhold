import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainedWorkHealth } from "../core/health.ts";

test("retained-work health tolerates a file disappearing during its scan", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-health-race-"));
  try {
    const raw = join(root, "inbox", "raw");
    mkdirSync(raw, { recursive: true });
    symlinkSync(join(raw, "already-acked"), join(raw, "capture.json"));
    expect(retainedWorkHealth(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
