import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchAndExtract, type FetchLike } from "../daemon/extract.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "extract");
const articleHtml = readFileSync(join(FIXTURES, "article.html"), "utf8");
const thinHtml = readFileSync(join(FIXTURES, "thin.html"), "utf8");

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function fetchOnce(res: Response): FetchLike {
  return async () => res;
}

describe("fetchAndExtract happy path", () => {
  test("extracts a realistic article via injected fetchFn", async () => {
    const result = await fetchAndExtract(
      "https://example.com/essays/craft-of-extraction",
      { fetchFn: fetchOnce(htmlResponse(articleHtml)), minBodyChars: 400 },
    );
    if (!result.ok) throw new Error(`extraction failed: ${result.reason}`);
    expect(result.bodyMd).toContain("## Why boilerplate wins by default");
    expect(result.canonicalUrl).toBe(
      "https://example.com/essays/craft-of-extraction",
    );
    expect(result.author).toBe("Jane Doe");
    expect(result.publishedAt).toBe("2026-03-14T09:00:00.000Z");
    expect(result.wordCount).toBeGreaterThan(300);
  });

  test("sends browser-shaped headers and manually validates redirects", async () => {
    let seenInit: RequestInit | undefined;
    const fetchFn: FetchLike = async (_url, init) => {
      seenInit = init;
      return htmlResponse(articleHtml);
    };
    const result = await fetchAndExtract("https://example.com/a", {
      fetchFn,
      minBodyChars: 400,
    });
    expect(result.ok).toBe(true);
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["user-agent"]).toContain("Mozilla/5.0");
    expect(headers["accept"]).toContain("text/html");
    expect(seenInit?.redirect).toBe("manual");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("fetchAndExtract outbound URL policy", () => {
  test("file, loopback, and private IP urls never reach fetch", async () => {
    let called = 0;
    const fetchFn: FetchLike = async () => {
      called += 1;
      return htmlResponse(articleHtml);
    };
    for (const url of [
      "file:///etc/hosts",
      "http://127.0.0.1/private",
      "http://10.0.0.1/private",
      "http://169.254.169.254/latest/meta-data",
    ]) {
      const result = await fetchAndExtract(url, { fetchFn, minBodyChars: 400 });
      expect(result).toEqual({
        ok: false,
        reason: "forbidden_url",
        transient: false,
      });
    }
    expect(called).toBe(0);
  });

  test("a redirect to a private target is rejected before the second fetch", async () => {
    const seen: string[] = [];
    const result = await fetchAndExtract("https://example.com/start", {
      minBodyChars: 400,
      fetchFn: async (url) => {
        seen.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/admin" },
        });
      },
    });
    expect(result).toEqual({
      ok: false,
      reason: "redirect_forbidden",
      transient: false,
    });
    expect(seen).toEqual(["https://example.com/start"]);
  });

  test("a public-looking hostname resolving to loopback is rejected", async () => {
    let called = 0;
    const result = await fetchAndExtract("https://rebind.example/article", {
      minBodyChars: 400,
      resolveHost: async () => ["127.0.0.1"],
      fetchFn: async () => {
        called += 1;
        return htmlResponse(articleHtml);
      },
    });
    expect(result).toEqual({
      ok: false,
      reason: "forbidden_url",
      transient: false,
    });
    expect(called).toBe(0);
  });
});

describe("fetchAndExtract content-type handling", () => {
  test("application/pdf -> pdf_unsupported", async () => {
    const res = new Response("%PDF-1.7", {
      headers: { "content-type": "application/pdf" },
    });
    const result = await fetchAndExtract("https://example.com/paper.pdf", {
      fetchFn: fetchOnce(res),
      minBodyChars: 400,
    });
    expect(result).toEqual({
      ok: false,
      reason: "pdf_unsupported",
      transient: false,
    });
  });

  test("other non-html -> not_html", async () => {
    const res = new Response("{}", {
      headers: { "content-type": "application/json" },
    });
    const result = await fetchAndExtract("https://example.com/api", {
      fetchFn: fetchOnce(res),
      minBodyChars: 400,
    });
    expect(result).toEqual({ ok: false, reason: "not_html", transient: false });
  });
});

describe("fetchAndExtract status handling", () => {
  test("503 -> transient", async () => {
    const result = await fetchAndExtract("https://example.com/down", {
      fetchFn: fetchOnce(new Response("unavailable", { status: 503 })),
      minBodyChars: 400,
    });
    expect(result).toEqual({ ok: false, reason: "http_503", transient: true });
  });

  test("429 -> transient", async () => {
    const result = await fetchAndExtract("https://example.com/limited", {
      fetchFn: fetchOnce(new Response("slow down", { status: 429 })),
      minBodyChars: 400,
    });
    expect(result).toEqual({ ok: false, reason: "http_429", transient: true });
  });

  test("404 -> permanent", async () => {
    const result = await fetchAndExtract("https://example.com/gone", {
      fetchFn: fetchOnce(new Response("nope", { status: 404 })),
      minBodyChars: 400,
    });
    expect(result).toEqual({ ok: false, reason: "http_404", transient: false });
  });

  test("network error -> transient", async () => {
    const fetchFn: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await fetchAndExtract("https://example.com/unreachable", {
      fetchFn,
      minBodyChars: 400,
    });
    expect(result).toEqual({
      ok: false,
      reason: "network_error",
      transient: true,
    });
  });
});

describe("fetchAndExtract special hosts short-circuit before fetch", () => {
  test("youtube urls never hit the network", async () => {
    let called = 0;
    const fetchFn: FetchLike = async () => {
      called++;
      return htmlResponse(articleHtml);
    };
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
    ]) {
      const result = await fetchAndExtract(url, { fetchFn, minBodyChars: 400 });
      expect(result).toEqual({
        ok: false,
        reason: "youtube_unsupported",
        transient: false,
      });
    }
    expect(called).toBe(0);
  });

  test("x/twitter status urls never hit the network", async () => {
    let called = 0;
    const fetchFn: FetchLike = async () => {
      called++;
      return htmlResponse(articleHtml);
    };
    for (const url of [
      "https://x.com/someone/status/1234567890123",
      "https://twitter.com/someone/status/1234567890123",
    ]) {
      const result = await fetchAndExtract(url, { fetchFn, minBodyChars: 400 });
      expect(result).toEqual({
        ok: false,
        reason: "x_unsupported",
        transient: false,
      });
    }
    expect(called).toBe(0);
  });

  test("non-status x urls do fetch", async () => {
    let called = 0;
    const fetchFn: FetchLike = async () => {
      called++;
      return new Response("nope", { status: 404 });
    };
    const result = await fetchAndExtract("https://x.com/i/bookmarks", {
      fetchFn,
      minBodyChars: 400,
    });
    expect(called).toBe(1);
    expect(result).toEqual({ ok: false, reason: "http_404", transient: false });
  });
});

describe("fetchAndExtract size cap", () => {
  test("oversized streamed body -> too_large", async () => {
    const chunk = new TextEncoder().encode("a".repeat(64 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = new Response(stream, {
      headers: { "content-type": "text/html" },
    });
    const result = await fetchAndExtract("https://example.com/huge", {
      fetchFn: fetchOnce(res),
      minBodyChars: 400,
      maxBytes: 200_000,
    });
    expect(result).toEqual({
      ok: false,
      reason: "too_large",
      transient: false,
    });
  });

  test("declared content-length over the cap -> too_large without reading", async () => {
    const res = new Response("tiny", {
      headers: {
        "content-type": "text/html",
        "content-length": String(50 * 1024 * 1024),
      },
    });
    const result = await fetchAndExtract("https://example.com/declared-huge", {
      fetchFn: fetchOnce(res),
      minBodyChars: 400,
    });
    expect(result).toEqual({
      ok: false,
      reason: "too_large",
      transient: false,
    });
  });
});

describe("fetchAndExtract thin content", () => {
  test("paywall shell over the wire -> thin_content", async () => {
    const result = await fetchAndExtract(
      "https://news.example.com/exclusive-inside-story",
      { fetchFn: fetchOnce(htmlResponse(thinHtml)), minBodyChars: 400 },
    );
    expect(result).toEqual({
      ok: false,
      reason: "thin_content",
      transient: false,
    });
  });
});
