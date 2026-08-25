import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractFromHtml } from "../daemon/extract.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "extract");
const articleHtml = readFileSync(join(FIXTURES, "article.html"), "utf8");
const thinHtml = readFileSync(join(FIXTURES, "thin.html"), "utf8");

describe("extractFromHtml on a realistic article", () => {
  const result = extractFromHtml(
    articleHtml,
    "https://example.com/essays/craft-of-extraction?utm_source=tw",
    400,
  );

  test("succeeds with substantive markdown body", () => {
    if (!result.ok) throw new Error(`extraction failed: ${result.reason}`);
    expect(result.bodyMd).toContain("turning a web page");
    expect(result.bodyMd).toContain("## Why boilerplate wins by default");
    expect(result.bodyMd).toContain("## What must survive the trip");
    expect(result.bodyMd).toContain(
      "[Readability](https://github.com/mozilla/readability)",
    );
    expect(result.bodyMd).toContain("> The reader does not care");
    expect(result.bodyMd).toContain("```");
    expect(result.bodyMd).toContain("const captures = await drain(inbox);");
  });

  test("strips script, style, and page chrome", () => {
    if (!result.ok) throw new Error(`extraction failed: ${result.reason}`);
    expect(result.bodyMd).not.toContain("dataLayer");
    expect(result.bodyMd).not.toContain("font-family");
    expect(result.bodyMd).not.toContain("All rights reserved");
    expect(result.bodyMd).not.toContain("Subscribe for weekly posts");
  });

  test("pulls head metadata", () => {
    if (!result.ok) throw new Error(`extraction failed: ${result.reason}`);
    expect(result.canonicalUrl).toBe(
      "https://example.com/essays/craft-of-extraction",
    );
    expect(result.author).toBe("Jane Doe");
    expect(result.publishedAt).toBe("2026-03-14T09:00:00.000Z");
    expect(result.title).toContain("The Craft of Extraction");
  });

  test("word-counts the markdown", () => {
    if (!result.ok) throw new Error(`extraction failed: ${result.reason}`);
    expect(result.wordCount).toBeGreaterThan(300);
    expect(result.wordCount).toBeLessThan(900);
  });
});

describe("extractFromHtml honest failures", () => {
  test("thin paywall shell -> thin_content, not transient", () => {
    const result = extractFromHtml(
      thinHtml,
      "https://news.example.com/exclusive-inside-story",
      400,
    );
    expect(result).toEqual({
      ok: false,
      reason: "thin_content",
      transient: false,
    });
  });

  test("empty html -> not ok, not transient", () => {
    const result = extractFromHtml("", "https://example.com/x", 100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.transient).toBe(false);
  });
});

describe("extractFromHtml metadata edge cases", () => {
  const filler =
    "A paragraph long enough for readability scoring to keep, with commas, " +
    "clauses, and enough plain prose to pass the candidate threshold. ";
  const body = `<article><h1>T</h1><p>${filler.repeat(6)}</p><p>${filler.repeat(6)}</p></article>`;

  test("relative canonical resolves against the page url", () => {
    const html = `<html><head><link rel="canonical" href="/canonical-path"></head><body>${body}</body></html>`;
    const result = extractFromHtml(
      html,
      "https://blog.example.org/posts/1",
      50,
    );
    if (!result.ok) throw new Error(`extraction failed: ${result.reason}`);
    expect(result.canonicalUrl).toBe("https://blog.example.org/canonical-path");
  });

  test("og:url is the canonical fallback", () => {
    const html = `<html><head><meta property="og:url" content="https://example.org/via-og"></head><body>${body}</body></html>`;
    const result = extractFromHtml(html, "https://example.org/p", 50);
    if (!result.ok) throw new Error(`extraction failed: ${result.reason}`);
    expect(result.canonicalUrl).toBe("https://example.org/via-og");
  });

  test("absent metadata stays absent", () => {
    const html = `<html><head><title>Bare</title></head><body>${body}</body></html>`;
    const result = extractFromHtml(html, "https://example.org/bare", 50);
    if (!result.ok) throw new Error(`extraction failed: ${result.reason}`);
    expect(result.canonicalUrl).toBeUndefined();
    expect(result.author).toBeUndefined();
    expect(result.publishedAt).toBeUndefined();
  });

  test("article:author profile urls are not treated as author names", () => {
    const html = `<html><head><meta property="article:author" content="https://facebook.com/janedoe"></head><body>${body}</body></html>`;
    const result = extractFromHtml(html, "https://example.org/a", 50);
    if (!result.ok) throw new Error(`extraction failed: ${result.reason}`);
    expect(result.author).toBeUndefined();
  });
});
