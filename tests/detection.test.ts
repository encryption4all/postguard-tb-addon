import { describe, it, expect } from "vitest";

// These tests verify PostGuard message detection (isPGEncrypted, wasPGEncrypted).
// They require browser API mocks.

describe("isPGEncrypted", () => {
  it.todo("should detect message with postguard.encrypted attachment");

  it.todo("should detect message with armored PostGuard block in HTML body");

  it.todo("should return false for plain unencrypted message");

  it.todo("should return false for message with unrelated attachments");

  it.todo("should not false-positive on messages mentioning PostGuard in text");

  it.todo("should handle messages where getFull throws");
});

describe("wasPGEncrypted", () => {
  it.todo("should detect message with X-PostGuard header");

  it.todo("should return false for message without X-PostGuard header");
});
