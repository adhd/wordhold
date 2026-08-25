import { describe, expect, test } from "bun:test";
import {
  highlightDedupeKey,
  newsletterPseudoUrl,
  normalizeUrl,
  slugify,
  urlHash,
} from "../core/urls.ts";

describe("normalizeUrl", () => {
  test("lowercases scheme and host, strips fragment and default port", () => {
    expect(normalizeUrl("HTTPS://Example.COM:443/Path#section")).toBe(
      "https://example.com/Path",
    );
    expect(normalizeUrl("http://example.com:80/a")).toBe(
      "http://example.com/a",
    );
  });

  test("strips tracking params but preserves meaningful ones in order", () => {
    expect(
      normalizeUrl(
        "https://example.com/a?b=2&utm_source=tw&utm_campaign=x&fbclid=zz&a=1",
      ),
    ).toBe("https://example.com/a?b=2&a=1");
    expect(
      normalizeUrl(
        "https://example.com/a?gclid=1&igshid=2&mc_cid=3&mc_eid=4&ref_src=5",
      ),
    ).toBe("https://example.com/a");
  });

  test("strips s and t only on twitter/x hosts", () => {
    expect(normalizeUrl("https://x.com/user/status/123?s=20&t=abc")).toBe(
      "https://x.com/user/status/123",
    );
    expect(normalizeUrl("https://mobile.twitter.com/u/status/9?s=20")).toBe(
      "https://mobile.twitter.com/u/status/9",
    );
    expect(normalizeUrl("https://example.com/a?s=1&t=2")).toBe(
      "https://example.com/a?s=1&t=2",
    );
  });

  test("normalizes trailing slash on path-only urls, keeps root slash", () => {
    expect(normalizeUrl("https://example.com/a/")).toBe(
      "https://example.com/a",
    );
    expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
    // with a query string the path is left alone
    expect(normalizeUrl("https://example.com/a/?q=1")).toBe(
      "https://example.com/a/?q=1",
    );
  });

  test("adds https scheme when missing", () => {
    expect(normalizeUrl("example.com/foo")).toBe("https://example.com/foo");
  });

  test("rejects non-web schemes and local/private targets", () => {
    for (const url of [
      "file:///etc/hosts",
      "http://localhost/admin",
      "http://127.0.0.1:8080/",
      "http://10.2.3.4/",
      "http://172.16.1.2/",
      "http://192.168.1.2/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://[::ffff:7f00:1]/",
    ]) {
      expect(() => normalizeUrl(url)).toThrow();
    }
  });

  test("equivalent forms hash identically", () => {
    const a = urlHash(normalizeUrl("https://Example.com/post?utm_source=x"));
    const b = urlHash(normalizeUrl("https://example.com/post"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("highlightDedupeKey", () => {
  test("case and whitespace insensitive, item-scoped", () => {
    const k1 = highlightDedupeKey("pt_aaaaaaaaaa", "Hello   World");
    const k2 = highlightDedupeKey("pt_aaaaaaaaaa", "hello world\n");
    const k3 = highlightDedupeKey("pt_bbbbbbbbbb", "hello world");
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("newsletterPseudoUrl", () => {
  test("builds newsletter:// pseudo url from domain and slugified subject", () => {
    expect(newsletterPseudoUrl("Substack.com", "My Great Post!")).toBe(
      "newsletter://substack.com/my-great-post",
    );
    expect(
      newsletterPseudoUrl("@list.example.org", "Weekly #42: The Roundup"),
    ).toBe("newsletter://list.example.org/weekly-42-the-roundup");
    expect(newsletterPseudoUrl("a.com", "!!!")).toBe(
      "newsletter://a.com/untitled",
    );
  });
});

describe("slugify", () => {
  test("caps length and trims dashes", () => {
    const s = slugify("A ".repeat(100) + "end", 60);
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith("-")).toBe(false);
    expect(slugify("Héllo Wörld")).toBe("hello-world");
  });
});
