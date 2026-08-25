// One-shot external acceptance check. It sends exactly one real weekly digest
// from a temporary seeded corpus and never changes the scheduled dry-run flag.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveRepoRoot } from "../core/config.ts";
import { openDb } from "../core/db.ts";
import { ingestCapture, recordFetchResult } from "../core/store.ts";
import type { WordholdConfig } from "../core/types.ts";
import {
  runWeeklyDigest,
  type DigestOptions,
} from "../daemon/digest.ts";
import type { SendResult } from "../daemon/imessage.ts";

interface VerifyDeps {
  now?: Date;
  send?: DigestOptions["send"];
  // Tests must opt in explicitly while still injecting a non-delivering sender.
  authorizeForTest?: () => boolean;
}

export async function verifyLiveDigest(
  config: WordholdConfig,
  deps: VerifyDeps = {},
): Promise<SendResult> {
  const environmentAuthorized = process.env.PAPERTRAIL_LIVE_VERIFY === "1";
  const testAuthorized = deps.authorizeForTest?.() === true;
  if (!environmentAuthorized && !testAuthorized) {
    throw new Error("refusing live send without PAPERTRAIL_LIVE_VERIFY=1");
  }
  if (!environmentAuthorized && testAuthorized && !deps.send) {
    throw new Error("test authorization requires an injected sender");
  }
  if (!config.imessage.recipient.trim()) {
    throw new Error("configured iMessage recipient required");
  }
  const now = deps.now ?? new Date();
  const root = mkdtempSync(join(tmpdir(), "papertrail-live-digest-"));
  const db = openDb(root);
  try {
    const item = ingestCapture(root, db, {
      kind: "save",
      source: "shortcut",
      url: "https://example.com/papertrail-live-verification",
      title: "Wordhold live verification",
      capturedAt: now.toISOString(),
    }).item;
    recordFetchResult(
      root,
      db,
      item.id,
      { error: "paywall_or_js_empty", transient: false },
      1,
    );
    const liveConfig: WordholdConfig = {
      ...config,
      imessage: { ...config.imessage, dryRun: false },
    };
    const result = await runWeeklyDigest({
      repoRoot: root,
      db,
      config: liveConfig,
      now,
      ...(deps.send ? { send: deps.send } : {}),
    });
    if (!result.sent || result.dryRun) {
      throw new Error("live digest verification did not report delivery");
    }
    return result;
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await verifyLiveDigest(loadConfig(resolveRepoRoot()));
  console.log("live verification digest sent");
}
