// Ambient Safari Reading List pull. Copies the live plist to scratch before
// parsing (avoids torn reads), converts with plutil, and returns EVERY current
// entry on every pull: ingestion is append-only by design, store-level url
// dedupe makes re-pulls no-ops, and upstream deletions are ignored. No ack.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMParser } from "linkedom";
import {
  AdapterHardError,
  type AdapterContext,
  type Capture,
  type SourceAdapter,
} from "../../core/types.ts";

export interface PlutilResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type PlutilRunner = (cmd: string[]) => Promise<PlutilResult>;

async function spawnPlutil(cmd: string[]): Promise<PlutilResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

type PlistValue =
  string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

// plutil cannot emit JSON for plists containing <date> values, and the real
// Bookmarks.plist always has them (DateAdded). Fallback path: convert to xml1
// and walk it; dates become their ISO-8601 text.
function fromXmlElement(el: Element): PlistValue | null {
  switch (el.tagName) {
    case "dict": {
      const out: Record<string, PlistValue> = {};
      const kids = [...el.children];
      for (let i = 0; i + 1 < kids.length; i += 2) {
        if (kids[i].tagName !== "key") continue;
        const v = fromXmlElement(kids[i + 1]);
        if (v !== null) out[kids[i].textContent ?? ""] = v;
      }
      return out;
    }
    case "array": {
      const out: PlistValue[] = [];
      for (const child of el.children) {
        const v = fromXmlElement(child);
        if (v !== null) out.push(v);
      }
      return out;
    }
    case "string":
    case "date":
    case "data":
      return el.textContent ?? "";
    case "integer":
    case "real":
      return Number(el.textContent);
    case "true":
      return true;
    case "false":
      return false;
    default:
      return null;
  }
}

function parseXmlPlist(xml: string): PlistValue | null {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.querySelector("plist > *");
  return root ? fromXmlElement(root as unknown as Element) : null;
}

function findReadingListChildren(
  node: unknown,
): Record<string, unknown>[] | null {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findReadingListChildren(child);
      if (found) return found;
    }
    return null;
  }
  const dict = node as Record<string, unknown>;
  if (dict.Title === "com.apple.ReadingList") {
    return Array.isArray(dict.Children)
      ? (dict.Children as Record<string, unknown>[])
      : []; // Safari omits Children when the list is empty
  }
  return findReadingListChildren(dict.Children);
}

export interface ReadingListAdapter extends SourceAdapter {
  // Set by pull() when the plist is absent.
  readonly note: string | undefined;
}

export function createReadingListAdapter(
  deps: { runner?: PlutilRunner; copyFile?: typeof copyFileSync } = {},
): ReadingListAdapter {
  const runner = deps.runner ?? spawnPlutil;
  const copyFile = deps.copyFile ?? copyFileSync;
  let note: string | undefined;

  return {
    name: "reading_list",
    get note() {
      return note;
    },

    async pull(ctx: AdapterContext): Promise<Capture[]> {
      note = undefined;
      const src = ctx.config.readingListPlist;
      const scratch = mkdtempSync(join(tmpdir(), "pt-readinglist-"));
      const tmp = join(scratch, "Bookmarks.plist");
      try {
        try {
          // Attempt the read directly: stat succeeds on TCC-protected files
          // while open fails, so an existence check cannot detect denial.
          copyFile(src, tmp);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            note = `no Bookmarks.plist at ${src}; Safari Reading List unavailable`;
            return [];
          }
          if (code === "EPERM" || code === "EACCES") {
            throw new AdapterHardError(
              "reading_list",
              `cannot read ${src} (${code}): the daemon binary needs Full Disk Access ` +
                `(System Settings > Privacy & Security > Full Disk Access). ` +
                `The grant is per-binary; re-grant after replacing or upgrading the daemon executable.`,
            );
          }
          throw err;
        }

        const asJson = await runner([
          "plutil",
          "-convert",
          "json",
          "-o",
          "-",
          tmp,
        ]);
        let root: unknown;
        if (asJson.exitCode === 0) {
          root = JSON.parse(asJson.stdout);
        } else {
          const asXml = await runner([
            "plutil",
            "-convert",
            "xml1",
            "-o",
            "-",
            tmp,
          ]);
          if (asXml.exitCode !== 0) {
            throw new Error(
              `plutil failed on ${src}: ${asXml.stderr.trim() || asJson.stderr.trim() || "unknown error"}`,
            );
          }
          root = parseXmlPlist(asXml.stdout);
        }

        const entries = findReadingListChildren(root) ?? [];
        const now = new Date().toISOString();
        const captures: Capture[] = [];
        for (const entry of entries) {
          const url = entry.URLString;
          if (typeof url !== "string" || url.length === 0) continue;
          const uri = entry.URIDictionary as
            Record<string, unknown> | undefined;
          const rl = entry.ReadingList as Record<string, unknown> | undefined;
          captures.push({
            kind: "save",
            source: "reading_list",
            url,
            title: typeof uri?.title === "string" ? uri.title : undefined,
            capturedAt: typeof rl?.DateAdded === "string" ? rl.DateAdded : now,
          });
        }
        return captures;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
}
