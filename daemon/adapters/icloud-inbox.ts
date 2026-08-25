// Drains capture files written by the iOS Shortcuts to the iCloud Documents
// folder. Files are deleted only in ack(), after the store has committed them
// (at-least-once delivery; store-level dedupe makes replays no-ops).
import {
  chmodSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import type {
  AdapterContext,
  Capture,
  SourceAdapter,
} from "../../core/types.ts";
import { log } from "../../core/log.ts";
import { ensurePrivateDir } from "../../core/private-fs.ts";
import {
  atomicCopyFile,
  FileTooLargeError,
  readFileBounded,
} from "../../core/atomic.ts";
import {
  MAX_CAPTURE_JSON_BYTES,
  parseIdempotencyKey,
  parseSaveHighlightPayload,
} from "../../core/capture-input.ts";
import {
  classifyIphoneCaptureFile,
  isIphoneCapturePlaceholder,
  type IphoneCaptureFile,
} from "../../core/iphone-capture-file.ts";

// Both legacy JSON workflows and the versioned Link handoff use this shape.
interface ShortcutCaptureFile {
  kind: "save" | "highlight" | "note";
  url?: string;
  title?: string;
  text?: string;
  capturedAt?: string;
  idempotencyKey?: string;
}

const PARSE_SETTLE_MS = 2_000;

export interface IcloudInboxAdapter extends SourceAdapter {
  // Set by pull() when the inbox dir is absent (Shortcuts not set up yet).
  readonly note: string | undefined;
  // Undownloaded iCloud placeholders (".<name>.icloud") seen on the last pull;
  // surfaced in health reporting, never treated as an error.
  readonly icloudPlaceholderCount: number;
}

// iCloud placeholders are named ".<original name>.icloud".
function isPlaceholder(name: string): boolean {
  return isIphoneCapturePlaceholder(name);
}

export function moveToBadCaptures(
  repoRoot: string,
  src: string,
  deps: { rename?: typeof renameSync } = {},
): void {
  const dir = join(repoRoot, "logs", "bad-captures");
  ensurePrivateDir(dir);
  const base = join(dir, basename(src));
  let dest = base;
  for (let suffix = 1; existsSync(dest); suffix += 1) {
    dest = `${base}.${suffix}`;
  }
  try {
    (deps.rename ?? renameSync)(src, dest);
  } catch {
    // iCloud's File Provider can return EXDEV or EDEADLK. Stream into an
    // atomic destination so hostile evidence is never buffered whole in RAM.
    atomicCopyFile(src, dest);
    rmSync(src, { force: true });
  }
  chmodSync(dest, 0o600);
}

function parseShortcutCapture(
  value: unknown,
  file: IphoneCaptureFile,
): ShortcutCaptureFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capture must be an object");
  }
  const input = value as Record<string, unknown>;
  if (file.kind === "link") {
    const keys = Object.keys(input).sort();
    if (
      input.buildMarker !== file.buildMarker ||
      input.kind !== "save" ||
      JSON.stringify(keys) !==
        JSON.stringify(["buildMarker", "kind", "url"])
    ) {
      throw new Error(`invalid ${file.version} Link text handoff envelope`);
    }
  }
  if (
    input.kind !== "save" &&
    input.kind !== "highlight" &&
    input.kind !== "note"
  ) {
    throw new Error(`unknown kind ${String(input.kind)}`);
  }
  return {
    kind: input.kind,
    ...parseSaveHighlightPayload(input.kind, input),
    idempotencyKey: parseIdempotencyKey(input.idempotencyKey),
  };
}

export function createIcloudInboxAdapter(
  deps: {
    readFile?: typeof readFileBounded;
    moveToBad?: typeof moveToBadCaptures;
    now?: () => number;
  } = {},
): IcloudInboxAdapter {
  let note: string | undefined;
  let placeholders = 0;

  return {
    name: "icloud_inbox",
    get note() {
      return note;
    },
    get icloudPlaceholderCount() {
      return placeholders;
    },

    async pull(ctx: AdapterContext): Promise<Capture[]> {
      note = undefined;
      placeholders = 0;
      const dir = ctx.config.icloudInboxDir;
      if (!dir || !existsSync(dir)) {
        note = "iCloud inbox dir missing; Shortcuts not set up yet";
        return [];
      }
      const captures: Capture[] = [];
      let rejected = 0;
      for (const name of readdirSync(dir).sort()) {
        if (isPlaceholder(name)) {
          placeholders += 1;
          continue;
        }
        const file = classifyIphoneCaptureFile(name);
        if (!file) continue;
        const path = join(dir, name);
        let bytes: Uint8Array;
        try {
          bytes = (deps.readFile ?? readFileBounded)(path, MAX_CAPTURE_JSON_BYTES);
        } catch (error) {
          if (!(error instanceof FileTooLargeError)) {
            const reason = error instanceof Error ? error.message : String(error);
            log(
              ctx.repoRoot,
              "icloud_inbox",
              `deferred unreadable Shortcut capture ${JSON.stringify(name)}: ${reason}`,
            );
            continue;
          }
          try {
            (deps.moveToBad ?? moveToBadCaptures)(ctx.repoRoot, path);
          } catch (moveError) {
            const reason = moveError instanceof Error ? moveError.message : String(moveError);
            log(
              ctx.repoRoot,
              "icloud_inbox",
              `deferred Shortcut quarantine ${JSON.stringify(name)}: ${reason}`,
            );
            continue;
          }
          rejected += 1;
          log(
            ctx.repoRoot,
            "icloud_inbox",
            `invalid Shortcut capture ${JSON.stringify(name)}: ${error.message}`,
          );
          continue;
        }
        let parsed: ShortcutCaptureFile;
        try {
          parsed = parseShortcutCapture(
            JSON.parse(new TextDecoder().decode(bytes)),
            file,
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          let modifiedAt: number;
          try {
            modifiedAt = statSync(path).mtimeMs;
          } catch (statError) {
            const statReason = statError instanceof Error ? statError.message : String(statError);
            log(
              ctx.repoRoot,
              "icloud_inbox",
              `deferred unreadable Shortcut capture ${JSON.stringify(name)}: ${statReason}`,
            );
            continue;
          }
          if ((deps.now ?? Date.now)() - modifiedAt < PARSE_SETTLE_MS) {
            log(
              ctx.repoRoot,
              "icloud_inbox",
              `deferred fresh invalid Shortcut capture ${JSON.stringify(name)}: ${reason}`,
            );
            continue;
          }
          try {
            (deps.moveToBad ?? moveToBadCaptures)(ctx.repoRoot, path);
          } catch (moveError) {
            const moveReason = moveError instanceof Error ? moveError.message : String(moveError);
            log(
              ctx.repoRoot,
              "icloud_inbox",
              `deferred Shortcut quarantine ${JSON.stringify(name)}: ${moveReason}`,
            );
            continue;
          }
          rejected += 1;
          log(
            ctx.repoRoot,
            "icloud_inbox",
            `invalid Shortcut capture ${JSON.stringify(name)}: ${reason}`,
          );
          continue;
        }
        const idempotencyKey = parsed.idempotencyKey ?? name;
        captures.push({
          kind: parsed.kind,
          source: parsed.kind === "highlight" ? "highlight_share" : "shortcut",
          url: parsed.url,
          title: parsed.title,
          text: parsed.text,
          capturedAt: parsed.capturedAt ?? new Date().toISOString(),
          idempotencyKey,
          upstreamId: name,
        });
      }
      if (rejected > 0) {
        note = `${rejected} Shortcut capture${rejected === 1 ? "" : "s"} rejected; see logs/bad-captures`;
      }
      return captures;
    },

    async ack(ctx: AdapterContext, accepted: Capture[]): Promise<void> {
      for (const c of accepted) {
        const name = c.upstreamId ?? c.idempotencyKey;
        if (!name || !classifyIphoneCaptureFile(name)) continue;
        rmSync(join(ctx.config.icloudInboxDir, basename(name)), { force: true });
      }
    },
  };
}
