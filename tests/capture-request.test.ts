import { expect, test } from "bun:test";
import { normalizeCaptureRequest } from "../core/capture-request.ts";

test("an X-style text share becomes one URL save with honest shared context", () => {
  const capture = normalizeCaptureRequest(
    {
      input:
        "This is worth keeping https://x.com/example/status/123?s=20 — especially the chart.",
      capturedAt: "2026-08-04T12:00:00-04:00",
    },
    "local_capture",
  );

  expect(capture).toEqual({
    kind: "save",
    source: "local_capture",
    url: "https://x.com/example/status/123?s=20",
    text:
      "This is worth keeping https://x.com/example/status/123?s=20 — especially the chart.",
    capturedAt: "2026-08-04T16:00:00.000Z",
  });
});

test("ordinary copied text becomes an honest text-only note", () => {
  const capture = normalizeCaptureRequest(
    {
      input: "Remember the distinction between queue durability and archival authority.",
      capturedAt: "2026-08-04T16:00:00Z",
    },
    "local_capture",
  );

  expect(capture).toEqual({
    kind: "note",
    source: "local_capture",
    text: "Remember the distinction between queue durability and archival authority.",
    capturedAt: "2026-08-04T16:00:00.000Z",
  });
});

test("an explicit highlight keeps exact selected text and page identity", () => {
  const capture = normalizeCaptureRequest(
    {
      intent: "highlight",
      input: "Queue acknowledgement follows the canonical git commit.",
      url: "https://example.com/article?utm_source=share",
      title: "Reliable Capture",
      idempotencyKey: "gesture-123",
      capturedAt: "2026-08-04T16:00:00Z",
    },
    "local_capture",
  );

  expect(capture).toEqual({
    kind: "highlight",
    source: "local_capture",
    url: "https://example.com/article?utm_source=share",
    title: "Reliable Capture",
    text: "Queue acknowledgement follows the canonical git commit.",
    capturedAt: "2026-08-04T16:00:00.000Z",
    idempotencyKey: "gesture-123",
  });
});

test("capture request identities are bounded before local durable queueing", () => {
  expect(() =>
    normalizeCaptureRequest(
      {
        input: "https://example.com/oversized-key",
        idempotencyKey: "x".repeat(513),
      },
      "local_capture",
    )
  ).toThrow("idempotencyKey");
});
