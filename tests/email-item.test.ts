import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  emailCaptureToItemInput,
  resolveTrackingLinks,
} from "../daemon/email-item.ts";
import type { Capture } from "../core/types.ts";
import { newsletterPseudoUrl } from "../core/urls.ts";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", "email", name), "utf8");

const emailCapture = (over: Partial<Capture> = {}): Capture => ({
  kind: "email",
  source: "newsletter",
  emailFrom: "author@list.example.org",
  emailSubject: "My Great Post",
  capturedAt: "2026-08-04T10:00:00Z",
  ...over,
});

describe("emailCaptureToItemInput url extraction", () => {
  test("a forwarded comment with one public URL becomes a link share with context", () => {
    const out = emailCaptureToItemInput(
      emailCapture({
        emailSubject: "Fwd: worth reading",
        text: "The queueing section matters: https://example.com/article?utm_source=email",
      }),
    );
    expect(out).toMatchObject({
      url: "https://example.com/article?utm_source=email",
      mode: "link_share",
      contextText:
        "The queueing section matters: https://example.com/article?utm_source=email",
      bodyMd: "",
    });
  });

  test("canonical link in html wins when no List-Post url", () => {
    const out = emailCaptureToItemInput(
      emailCapture({ html: fixture("substack-canonical.html") }),
    );
    expect(out.url).toBe("https://example.substack.com/p/my-great-post");
    expect(out.pseudoUrl).toBeNull();
  });

  test("http List-Post url takes precedence over canonical", () => {
    const out = emailCaptureToItemInput(
      emailCapture({
        url: "<https://example.com/from-list-post>, <mailto:post@list.example.org>",
        html: fixture("substack-canonical.html"),
      }),
    );
    expect(out.url).toBe("https://example.com/from-list-post");
  });

  test("mailto-only List-Post does not count; falls through to canonical", () => {
    const out = emailCaptureToItemInput(
      emailCapture({
        url: "<mailto:post@list.example.org>",
        html: fixture("substack-canonical.html"),
      }),
    );
    expect(out.url).toBe("https://example.substack.com/p/my-great-post");
  });

  test("og:url works when link rel=canonical is absent", () => {
    const out = emailCaptureToItemInput(
      emailCapture({
        html: '<html><head><meta property="og:url" content="https://blog.example.com/post-9"></head><body><p>Hi</p></body></html>',
      }),
    );
    expect(out.url).toBe("https://blog.example.com/post-9");
  });

  test("view-in-browser anchor is the last fallback; mailto anchors skipped", () => {
    const out = emailCaptureToItemInput(
      emailCapture({ html: fixture("view-in-browser.html") }),
    );
    expect(out.url).toBe("https://newsletter.example.org/issues/42");
    expect(out.pseudoUrl).toBeNull();
  });

  test("no url anywhere -> null url plus pseudoUrl", () => {
    const out = emailCaptureToItemInput(
      emailCapture({
        url: "<mailto:post@list.example.org>",
        html: fixture("no-canonical.html"),
      }),
    );
    expect(out.url).toBeNull();
    expect(out.pseudoUrl).toBe(
      newsletterPseudoUrl(
        "list.example.org",
        "My Great Post",
        emailCapture().capturedAt,
      ),
    );
  });

  test("pseudoUrl is stable across calls and strips Fwd prefixes", () => {
    const a = emailCaptureToItemInput(
      emailCapture({
        html: fixture("no-canonical.html"),
        emailSubject: "Fwd: My Great Post",
      }),
    );
    const b = emailCaptureToItemInput(
      emailCapture({
        html: fixture("no-canonical.html"),
        emailSubject: "My Great Post",
      }),
    );
    expect(a.pseudoUrl).toBe(b.pseudoUrl);
    expect(a.pseudoUrl).toBe(
      newsletterPseudoUrl(
        "list.example.org",
        "My Great Post",
        emailCapture().capturedAt,
      ),
    );
  });
});

test("tracking resolution never follows a redirect into a private target", async () => {
  const original =
    "Read [the source](https://email.mg2.substack.com/c/tracked) today.";
  const seen: string[] = [];
  const resolved = await resolveTrackingLinks(original, {
    fetchFn: async (url) => {
      seen.push(url);
      return {
        status: 302,
        headers: { get: () => "http://127.0.0.1/admin" },
      };
    },
  });
  expect(resolved).toBe(original);
  expect(seen).toEqual(["https://email.mg2.substack.com/c/tracked"]);
});

describe("emailCaptureToItemInput title and sender", () => {
  test("strips stacked Fwd/FW/Re prefixes case-insensitively", () => {
    const out = emailCaptureToItemInput(
      emailCapture({
        html: fixture("no-canonical.html"),
        emailSubject: "Fwd: FW: re: Actual Title",
      }),
    );
    expect(out.title).toBe("Actual Title");
  });

  test("keeps mid-subject Re intact", () => {
    const out = emailCaptureToItemInput(
      emailCapture({
        html: fixture("no-canonical.html"),
        emailSubject: "Thoughts re: the merger",
      }),
    );
    expect(out.title).toBe("Thoughts re: the merger");
  });

  test("empty subject -> null title, untitled pseudo url", () => {
    const out = emailCaptureToItemInput(
      emailCapture({ emailSubject: "", text: "hi" }),
    );
    expect(out.title).toBeNull();
    expect(out.pseudoUrl).toBe(
      newsletterPseudoUrl("list.example.org", "", emailCapture().capturedAt),
    );
  });

  test("extracts address from display-name form and lowercases", () => {
    const out = emailCaptureToItemInput(
      emailCapture({
        emailFrom: "Author Name <Author@List.Example.ORG>",
        text: "hi",
      }),
    );
    expect(out.sender).toBe("author@list.example.org");
    expect(out.senderDomain).toBe("list.example.org");
  });

  test("missing sender degrades to unknown domain", () => {
    const out = emailCaptureToItemInput(
      emailCapture({ emailFrom: undefined, text: "hi" }),
    );
    expect(out.senderDomain).toBe("unknown");
  });
});

describe("emailCaptureToItemInput body conversion", () => {
  test("html converts to markdown, keeps real content and links", () => {
    const out = emailCaptureToItemInput(
      emailCapture({ html: fixture("substack-canonical.html") }),
    );
    expect(out.bodyMd).toContain("# My Great Post");
    expect(out.bodyMd).toContain("peregrine falcons");
    expect(out.bodyMd).toContain(
      "[tracked link](https://email.mg2.substack.com/c/abc123)",
    );
    expect(out.bodyMd).toContain("chart.png"); // real image survives
  });

  test("drops tracking pixels, style, and script content", () => {
    const out = emailCaptureToItemInput(
      emailCapture({ html: fixture("substack-canonical.html") }),
    );
    expect(out.bodyMd).not.toContain("PIXEL");
    expect(out.bodyMd).not.toContain("STYLEPIXEL");
    expect(out.bodyMd).not.toContain("SECRET-STYLE-MARKER");
    expect(out.bodyMd).not.toContain("SECRET_SCRIPT_MARKER");
  });

  test("unwraps trivial layout tables into flowing text", () => {
    const out = emailCaptureToItemInput(
      emailCapture({ html: fixture("substack-canonical.html") }),
    );
    expect(out.bodyMd).toContain("First paragraph of the newsletter body");
    expect(out.bodyMd).not.toContain("|"); // no table remnants
  });

  test("plain text with no URL is classified for the daemon's body-length gate", () => {
    const out = emailCaptureToItemInput(
      emailCapture({ text: "line one\n\nline two" }),
    );
    expect(out).toMatchObject({
      mode: "plain_text",
      contextText: "line one\n\nline two",
      bodyMd: "line one\n\nline two",
      url: null,
    });
  });

  test("html producing no content falls back to text", () => {
    const out = emailCaptureToItemInput(
      emailCapture({
        html: "<html><body><img src='https://t.co/p.gif' width='1' height='1'></body></html>",
        text: "fallback body",
      }),
    );
    expect(out.bodyMd).toBe("fallback body");
  });
});
