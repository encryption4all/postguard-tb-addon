import { describe, it, expect } from "vitest";
import { toEmail, findHtmlBody } from "../src/lib/utils";

describe("toEmail", () => {
  it("should extract email from 'Name <email>' format", () => {
    expect(toEmail("Alice <alice@example.com>")).toBe("alice@example.com");
  });

  it("should return bare email unchanged (lowercased)", () => {
    expect(toEmail("bob@example.com")).toBe("bob@example.com");
  });

  it("should lowercase the extracted email", () => {
    expect(toEmail("Alice <ALICE@Example.COM>")).toBe("alice@example.com");
  });

  it("should handle empty display name", () => {
    expect(toEmail("<alice@example.com>")).toBe("alice@example.com");
  });

  it("should handle display name with special characters", () => {
    expect(toEmail("O'Brien, Bob <bob@example.com>")).toBe("bob@example.com");
  });

  it("should not be tricked by angle brackets in display name", () => {
    // The regex is greedy on .* before <, so it should still extract correctly
    const result = toEmail("Name <fake> <real@example.com>");
    expect(result).toBe("real@example.com");
  });

  it("should handle email-only input with mixed case", () => {
    expect(toEmail("USER@DOMAIN.COM")).toBe("user@domain.com");
  });
});

describe("findHtmlBody", () => {
  it("should find HTML body at top level", () => {
    const part = { contentType: "text/html", body: "<p>Hello</p>" };
    expect(findHtmlBody(part)).toBe("<p>Hello</p>");
  });

  it("should find HTML body in nested parts", () => {
    const part = {
      contentType: "multipart/alternative",
      parts: [
        { contentType: "text/plain", body: "Hello" },
        { contentType: "text/html", body: "<p>Hello</p>" },
      ],
    };
    expect(findHtmlBody(part)).toBe("<p>Hello</p>");
  });

  it("should find HTML body in deeply nested MIME structure", () => {
    const part = {
      contentType: "multipart/mixed",
      parts: [
        {
          contentType: "multipart/alternative",
          parts: [
            { contentType: "text/plain", body: "Hello" },
            { contentType: "text/html", body: "<p>Deep</p>" },
          ],
        },
        { contentType: "application/octet-stream" },
      ],
    };
    expect(findHtmlBody(part)).toBe("<p>Deep</p>");
  });

  it("should return null when no HTML body exists", () => {
    const part = {
      contentType: "multipart/mixed",
      parts: [{ contentType: "text/plain", body: "Just text" }],
    };
    expect(findHtmlBody(part)).toBeNull();
  });

  it("should return null for HTML part with empty body", () => {
    const part = { contentType: "text/html", body: "" };
    expect(findHtmlBody(part)).toBeNull();
  });

  it("should return null for empty structure", () => {
    expect(findHtmlBody({})).toBeNull();
  });

  it("should return the first HTML body found (depth-first)", () => {
    const part = {
      contentType: "multipart/mixed",
      parts: [
        { contentType: "text/html", body: "<p>First</p>" },
        { contentType: "text/html", body: "<p>Second</p>" },
      ],
    };
    expect(findHtmlBody(part)).toBe("<p>First</p>");
  });
});
