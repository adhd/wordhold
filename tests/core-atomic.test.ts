import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicCopyFile,
  atomicWriteFile,
  FileTooLargeError,
  readFileBounded,
} from "../core/atomic.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomicWriteFile replaces a canonical file completely and leaves no staging file", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-atomic-"));
  roots.push(root);
  const path = join(root, "items", "2026", "08", "article.md");

  atomicWriteFile(path, "first complete version\n");
  writeFileSync(path, "old content that must disappear\n");
  const replacement = "new canonical version\n".repeat(100_000);
  atomicWriteFile(path, replacement);

  expect(readFileSync(path, "utf8")).toBe(replacement);
  expect(readdirSync(join(root, "items", "2026", "08"))).toEqual([
    "article.md",
  ]);
});

test("atomic private writes create owner-only directories and files", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-atomic-private-"));
  roots.push(root);
  const path = join(root, "inbox", "raw", "capture.json");

  atomicWriteFile(path, "private capture evidence\n");

  for (const dir of [join(root, "inbox"), join(root, "inbox", "raw")]) {
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  }
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("bounded file reads accept the exact limit and reject one additional byte", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-bounded-read-"));
  roots.push(root);
  const path = join(root, "capture.json");
  writeFileSync(path, "12345");
  expect(new TextDecoder().decode(readFileBounded(path, 5))).toBe("12345");
  expect(() => readFileBounded(path, 4)).toThrow("file exceeds 4 bytes");
  expect(() => readFileBounded(path, 4)).toThrow(FileTooLargeError);
});

test("atomicCopyFile streams byte-exact private evidence to a complete destination", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-atomic-copy-"));
  roots.push(root);
  const source = join(root, "incoming.json");
  const destination = join(root, "quarantine", "incoming.json");
  const evidence = String.fromCharCode(0, 255, 10, 13).repeat(100_000);
  writeFileSync(source, evidence, "latin1");

  atomicCopyFile(source, destination);

  expect(readFileSync(destination)).toEqual(readFileSync(source));
  expect(readdirSync(join(root, "quarantine"))).toEqual(["incoming.json"]);
});
