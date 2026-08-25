import { expect, test } from "bun:test";
import {
  deliverShortcutCapture,
  normalizeShortcutShare,
} from "../core/shortcut-capture.ts";

test("an ordinary one-URL share preserves surrounding text as context", () => {
  expect(
    normalizeShortcutShare({
      urls: ["https://example.com/article"],
      sharedText: "Why this matters https://example.com/article",
      pageTitle: "Example article",
      capturedAt: "2026-08-09T12:00:00Z",
      idempotencyKey: "ios-gesture-1",
    }),
  ).toEqual({
    kind: "save",
    url: "https://example.com/article",
    title: "Example article",
    text: "Why this matters https://example.com/article",
    capturedAt: "2026-08-09T12:00:00.000Z",
    idempotencyKey: "ios-gesture-1",
  });
});

test("a Safari selection is a highlight only when page identity is present", () => {
  expect(
    normalizeShortcutShare({
      selectedText: "The exact selected passage.",
      pageUrl: "https://example.com/selected",
      pageTitle: "Selected article",
      capturedAt: "2026-08-09T12:01:00Z",
      idempotencyKey: "ios-gesture-2",
    }),
  ).toEqual({
    kind: "highlight",
    url: "https://example.com/selected",
    title: "Selected article",
    text: "The exact selected passage.",
    capturedAt: "2026-08-09T12:01:00.000Z",
    idempotencyKey: "ios-gesture-2",
  });
});

test("an explicit menu choice wins over Safari's automatic highlight shape", () => {
  const safari = {
    selectedText: "Selected words that can still be saved another way.",
    sharedText: "Selected words that can still be saved another way.",
    pageUrl: "https://example.com/selected",
    pageTitle: "Selected article",
    capturedAt: "2026-08-09T12:01:15Z",
    idempotencyKey: "ios-explicit-menu",
  };
  expect(normalizeShortcutShare({
    ...safari,
    choice: { kind: "note" },
  })).toMatchObject({ kind: "note", url: undefined, text: safari.selectedText });
  expect(normalizeShortcutShare({
    ...safari,
    choice: { kind: "url", url: safari.pageUrl },
  })).toMatchObject({ kind: "save", url: safari.pageUrl });
});

test("an ambiguous text-plus-URL share becomes a highlight only by explicit intent", () => {
  const input = {
    urls: ["https://example.com/ambiguous"],
    sharedText: "The passage explicitly marked by the reader.",
    capturedAt: "2026-08-09T12:01:30Z",
    idempotencyKey: "ios-gesture-ambiguous",
  };
  expect(normalizeShortcutShare(input)).toMatchObject({ kind: "save" });
  expect(normalizeShortcutShare({
    ...input,
    choice: { kind: "highlight", url: input.urls[0]! },
  })).toMatchObject({
    kind: "highlight",
    url: input.urls[0],
    text: input.sharedText,
  });
});

test("text without trustworthy page identity becomes an honest note", () => {
  expect(
    normalizeShortcutShare({
      selectedText: "A selection with no source page.",
      capturedAt: "2026-08-09T12:02:00Z",
      idempotencyKey: "ios-gesture-3",
    }),
  ).toEqual({
    kind: "note",
    text: "A selection with no source page.",
    capturedAt: "2026-08-09T12:02:00.000Z",
    idempotencyKey: "ios-gesture-3",
  });
});

test("a selection-popup Text input cannot be mislabeled as a sourced Safari highlight", () => {
  const input = {
    selectedText: "Selected text shared without its Safari page object.",
    capturedAt: "2026-08-13T22:55:00Z",
    idempotencyKey: "ios-selection-popup",
  };
  expect(() => normalizeShortcutShare({
    ...input,
    choice: { kind: "highlight", url: "https://example.com/not-supplied" },
  })).toThrow("chosen URL was not present in the share");
  expect(normalizeShortcutShare({
    ...input,
    choice: { kind: "note" },
  })).toMatchObject({
    kind: "note",
    url: undefined,
    text: input.selectedText,
  });
});

test("a multi-URL share requires choosing exactly one URL or the shared text as a note", () => {
  const common = {
    urls: ["https://example.com/one", "https://example.com/two"],
    sharedText: "Compare https://example.com/one with https://example.com/two",
    capturedAt: "2026-08-09T12:03:00Z",
    idempotencyKey: "ios-gesture-4",
  };
  expect(() => normalizeShortcutShare(common)).toThrow("choose one URL or save as note");
  expect(
    normalizeShortcutShare({
      ...common,
      choice: { kind: "url", url: "https://example.com/two" },
    }),
  ).toMatchObject({ kind: "save", url: "https://example.com/two" });
  expect(
    normalizeShortcutShare({ ...common, choice: { kind: "note" } }),
  ).toMatchObject({ kind: "note", text: common.sharedText, url: undefined });
  expect(() =>
    normalizeShortcutShare({
      ...common,
      choice: { kind: "url", url: "https://example.com/not-shared" },
    })
  ).toThrow("chosen URL was not present");
});

test("an unknown runtime choice cannot silently select the first shared URL", () => {
  expect(() => normalizeShortcutShare({
    urls: ["https://example.com/one", "https://example.com/two"],
    sharedText: "Two links with an invalid external choice.",
    capturedAt: "2026-08-09T12:03:10Z",
    idempotencyKey: "ios-invalid-choice",
    choice: { kind: "unexpected" } as never,
  })).toThrow("choice must be note, url, or highlight");
});

test("a runtime capture without an idempotency identity is refused", () => {
  expect(() => normalizeShortcutShare({
    sharedText: "Identity is required for replay convergence.",
    capturedAt: "2026-08-09T12:03:20Z",
  } as never)).toThrow("idempotency key required");
});

test("individually bounded fields cannot exceed the final Shortcut JSON limit", () => {
  expect(() => normalizeShortcutShare({
    urls: [`https://example.com/${"u".repeat(7_000)}`],
    pageTitle: "t".repeat(2_000),
    sharedText: String.fromCharCode(92).repeat(16_000),
    capturedAt: "2026-08-09T12:03:25Z",
    idempotencyKey: "k".repeat(500),
  })).toThrow("serialized capture exceeds 40960 bytes");
});

test("Safari pages, plain notes, and invalid shares keep honest intent", () => {
  const base = {
    capturedAt: "2026-08-09T12:03:30Z",
    idempotencyKey: "ios-shape",
  };
  expect(normalizeShortcutShare({
    ...base,
    pageUrl: "https://example.com/safari-page",
    pageTitle: "Safari page",
  })).toMatchObject({
    kind: "save",
    url: "https://example.com/safari-page",
    title: "Safari page",
  });
  expect(normalizeShortcutShare({
    ...base,
    sharedText: "A standalone thought.",
  })).toMatchObject({ kind: "note", text: "A standalone thought." });
  expect(() => normalizeShortcutShare(base)).toThrow("note text required");
  expect(() => normalizeShortcutShare({
    ...base,
    urls: ["http://127.0.0.1/private"],
  })).toThrow(/forbidden|not allowed|public/i);
  expect(() => normalizeShortcutShare({
    ...base,
    sharedText: "x".repeat(24 * 1024 + 1),
  })).toThrow("text exceeds 24576 bytes");
});

test("iCloud-only delivery writes locally and performs no HTTP action", async () => {
  const calls: string[] = [];
  const result = await deliverShortcutCapture(
    {
      kind: "note",
      text: "Queued without Cloudflare.",
      capturedAt: "2026-08-09T12:04:00.000Z",
      idempotencyKey: "ios-delivery-1",
    },
    {
      writeLocal: async () => calls.push("local"),
      sendWorker: undefined,
    },
  );
  expect(calls).toEqual(["local"]);
  expect(result).toEqual({
    status: "queued",
    local: "queued",
    remote: "disabled",
    message: "Queued for Wordhold validation.",
  });
});

test("optional Worker feedback cannot override local durability truth", async () => {
  const payload = {
    kind: "note" as const,
    text: "One capture, two delivery paths.",
    capturedAt: "2026-08-09T12:05:00.000Z",
    idempotencyKey: "ios-delivery-2",
  };
  const order: string[] = [];
  expect(await deliverShortcutCapture(payload, {
    writeLocal: async () => order.push("local"),
    sendWorker: async () => {
      order.push("worker");
      return "accepted";
    },
  })).toMatchObject({ status: "accepted", local: "queued", remote: "accepted" });
  expect(order).toEqual(["local", "worker"]);

  expect(await deliverShortcutCapture(payload, {
    writeLocal: async () => undefined,
    sendWorker: async () => "rejected",
  })).toMatchObject({ status: "queued", local: "queued", remote: "rejected" });

  expect(await deliverShortcutCapture(payload, {
    writeLocal: async () => undefined,
    sendWorker: async () => {
      throw new Error("offline");
    },
  })).toMatchObject({ status: "queued", local: "queued", remote: "unavailable" });

  let sent = false;
  expect(await deliverShortcutCapture(payload, {
    writeLocal: async () => {
      throw new Error("iCloud write failed");
    },
    sendWorker: async () => {
      sent = true;
      return "accepted";
    },
  })).toMatchObject({ status: "failed", local: "failed", remote: "not_attempted" });
  expect(sent).toBe(false);
});
