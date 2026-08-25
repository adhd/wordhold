import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../core/atomic.ts";
import type { Capture } from "../core/types.ts";

interface RawCaptureFile {
  version: 1;
  adapterName: string;
  capture: Capture;
}

export interface RawCaptureEntry {
  id: string;
  path: string;
  adapterName: string;
  capture: Capture;
}

export interface RawCaptureIssue {
  id: string;
  path: string;
  reason: string;
}

export interface RawCaptureScan {
  entries: RawCaptureEntry[];
  issues: RawCaptureIssue[];
}

function spoolDir(repoRoot: string): string {
  return join(repoRoot, "inbox", "raw");
}

function captureIdentity(adapterName: string, capture: Capture): string {
  const stable = capture.idempotencyKey
    ? `${adapterName}\n${capture.source}\n${capture.idempotencyKey}`
    : JSON.stringify({
        kind: capture.kind,
        source: capture.source,
        url: capture.url ?? null,
        title: capture.title ?? null,
        text: capture.text ?? null,
        html: capture.html ?? null,
        emailFrom: capture.emailFrom ?? null,
        emailSubject: capture.emailSubject ?? null,
        capturedAt: capture.capturedAt,
      });
  return createHash("sha256").update(stable).digest("hex");
}

function parseEntry(path: string, id: string): RawCaptureEntry {
  let parsed: RawCaptureFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as RawCaptureFile;
  } catch {
    throw new Error("invalid JSON");
  }
  if (parsed.version !== 1 || !parsed.capture?.kind) {
    throw new Error("invalid version or capture kind");
  }
  if (!parsed.adapterName) {
    throw new Error("missing adapter name");
  }
  return { id, path, adapterName: parsed.adapterName, capture: parsed.capture };
}

export function persistRawCapture(
  repoRoot: string,
  adapterName: string,
  capture: Capture,
): RawCaptureEntry {
  const id = captureIdentity(adapterName, capture);
  const path = join(spoolDir(repoRoot), `${id}.json`);
  if (!existsSync(path)) {
    const file: RawCaptureFile = { version: 1, adapterName, capture };
    atomicWriteFile(path, JSON.stringify(file));
  }
  return parseEntry(path, id);
}

export function scanRawCaptures(repoRoot: string): RawCaptureScan {
  const dir = spoolDir(repoRoot);
  const scan: RawCaptureScan = { entries: [], issues: [] };
  if (!existsSync(dir)) return scan;
  const names = readdirSync(dir)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .sort();
  for (const name of names) {
    const id = name.slice(0, -".json".length);
    const path = join(dir, name);
    try {
      scan.entries.push(parseEntry(path, id));
    } catch (error) {
      scan.issues.push({
        id,
        path,
        reason: error instanceof Error ? error.message : "invalid raw capture",
      });
    }
  }
  return scan;
}

export function listRawCaptures(repoRoot: string): RawCaptureEntry[] {
  return scanRawCaptures(repoRoot).entries;
}

export function removeRawCapture(entry: RawCaptureEntry): void {
  rmSync(entry.path, { force: true });
}
