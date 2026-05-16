import { describe, it, expect, beforeEach, vi } from "vitest";
import { isPGEncrypted, wasPGEncrypted } from "../src/lib/detection";
import { installBrowserMock, type BrowserMock } from "./helpers/browser-mock";

let mock: BrowserMock;

beforeEach(() => {
  mock = installBrowserMock();
});

const HTML_WITH_UUID =
  '<html><body><a href="https://cryptify.example/decrypt?uuid=11111111-2222-3333-4444-555555555555">decrypt</a></body></html>';

describe("isPGEncrypted", () => {
  it("should detect message with postguard.encrypted attachment", async () => {
    mock.messages.set(1, { id: 1, attachments: [{ name: "postguard.encrypted" }] });
    expect(await isPGEncrypted(1)).toBe(true);
  });

  it("should detect message with armored PostGuard block in HTML body", async () => {
    mock.messages.set(2, {
      id: 2,
      attachments: [],
      full: {
        headers: {},
        parts: [{ contentType: "text/html", body: HTML_WITH_UUID }],
      },
    });
    expect(await isPGEncrypted(2)).toBe(true);
  });

  it("should return false for plain unencrypted message", async () => {
    mock.messages.set(3, {
      id: 3,
      attachments: [],
      full: { headers: {}, parts: [{ contentType: "text/plain", body: "hello" }] },
    });
    expect(await isPGEncrypted(3)).toBe(false);
  });

  it("should return false for message with unrelated attachments", async () => {
    mock.messages.set(4, {
      id: 4,
      attachments: [{ name: "report.pdf" }, { name: "photo.jpg" }],
      full: { headers: {}, parts: [{ contentType: "text/html", body: "<p>hi</p>" }] },
    });
    expect(await isPGEncrypted(4)).toBe(false);
  });

  it("should not false-positive on messages mentioning PostGuard in text", async () => {
    mock.messages.set(5, {
      id: 5,
      attachments: [],
      full: {
        headers: {},
        parts: [
          {
            contentType: "text/html",
            body: "<p>We used PostGuard yesterday. No uuid here.</p>",
          },
        ],
      },
    });
    expect(await isPGEncrypted(5)).toBe(false);
  });

  it("should handle messages where getFull throws", async () => {
    mock.messages.set(6, { id: 6, attachments: [] });
    const orig = browser.messages.getFull;
    browser.messages.getFull = vi.fn(async () => {
      throw new Error("API failure");
    });
    try {
      expect(await isPGEncrypted(6)).toBe(false);
    } finally {
      browser.messages.getFull = orig;
    }
  });
});

describe("wasPGEncrypted", () => {
  it("should detect message with X-PostGuard header", async () => {
    mock.messages.set(10, {
      id: 10,
      full: { headers: { "x-postguard": ["0.1.0"] } },
    });
    expect(await wasPGEncrypted(10)).toBe(true);
  });

  it("should return false for message without X-PostGuard header", async () => {
    mock.messages.set(11, { id: 11, full: { headers: { "x-mailer": ["thunderbird"] } } });
    expect(await wasPGEncrypted(11)).toBe(false);
  });
});
