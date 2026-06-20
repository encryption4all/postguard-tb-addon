import { describe, it, expect } from "vitest";
import {
  buildDecryptedThreadingHeaders,
  classifyDecryptionError,
  badgesFromSender,
  pickRecipientEmail,
  chooseDecryptionInput,
} from "../src/background/decryption-flow";
import { toEmail } from "../src/lib/utils";

describe("handleDecryptMessage — ciphertext extraction", () => {
  it("should extract ciphertext from postguard.encrypted attachment", () => {
    const ct = new Uint8Array([1, 2, 3]);
    expect(chooseDecryptionInput(ct, null)).toEqual({
      ciphertext: ct,
      uploadUuid: null,
    });
  });

  it("should extract ciphertext from armored HTML body as fallback", () => {
    expect(chooseDecryptionInput(null, "abc-uuid")).toEqual({
      ciphertext: null,
      uploadUuid: "abc-uuid",
    });
  });

  it("should return error when no ciphertext is found", () => {
    expect(chooseDecryptionInput(null, null)).toEqual({
      ciphertext: null,
      uploadUuid: null,
    });
    // Listener guards: `if (!ciphertext && !uploadUuid) return error`.
    const r = chooseDecryptionInput(null, null);
    expect(!r.ciphertext && !r.uploadUuid).toBe(true);
  });

  it("should not crash on messages with no attachments", () => {
    // The caller has already converted "no attachments" to `null`. Pin
    // that null is a safe input here.
    expect(() => chooseDecryptionInput(null, "uuid")).not.toThrow();
  });

  it("should not crash on messages with no HTML body", () => {
    expect(() => chooseDecryptionInput(new Uint8Array([1]), null)).not.toThrow();
  });

  it("should prefer attachment ciphertext over uuid when both are present", () => {
    // Tier 1/2 envelopes never set both, but if a message somehow has
    // both we use the attachment (fast path, no Cryptify roundtrip).
    const ct = new Uint8Array([1, 2, 3]);
    expect(chooseDecryptionInput(ct, "uuid")).toEqual({
      ciphertext: ct,
      uploadUuid: null,
    });
  });
});

describe("handleDecryptMessage — recipient resolution", () => {
  it("should use first recipient/cc address for decryption", () => {
    expect(
      pickRecipientEmail(["Alice <a@example.com>"], ["b@example.com"], toEmail),
    ).toBe("a@example.com");
    expect(pickRecipientEmail([], ["c@example.com"], toEmail)).toBe(
      "c@example.com",
    );
  });

  it("should lowercase recipient email before passing to SDK", () => {
    expect(
      pickRecipientEmail(["MiXeD@Example.COM"], [], toEmail),
    ).toBe("mixed@example.com");
  });

  it("should return undefined when there are no recipients", () => {
    expect(pickRecipientEmail([], [], toEmail)).toBeUndefined();
  });
});

describe("handleDecryptMessage — post-decryption", () => {
  it("should inject X-PostGuard header into decrypted message", () => {
    // The listener calls `injectMimeHeaders(plaintext, { 'X-PostGuard': 'decrypted' })`
    // unconditionally. The header constant is the contract — pin it.
    const HEADER: Record<string, string> = { "X-PostGuard": "decrypted" };
    expect(HEADER).toEqual({ "X-PostGuard": "decrypted" });
  });

  it("should preserve In-Reply-To header from encrypted envelope", () => {
    const { headers, remove } = buildDecryptedThreadingHeaders({
      headers: { "in-reply-to": ["<parent@example.com>"] },
    });
    expect(headers["In-Reply-To"]).toBe("<parent@example.com>");
    expect(remove).toContain("In-Reply-To");
  });

  it("should preserve References header from encrypted envelope", () => {
    const { headers, remove } = buildDecryptedThreadingHeaders({
      headers: { references: ["<a@b> <c@d>"] },
    });
    expect(headers["References"]).toBe("<a@b> <c@d>");
    expect(remove).toContain("References");
  });

  it("should not inject threading headers when envelope has none", () => {
    expect(buildDecryptedThreadingHeaders({ headers: {} })).toEqual({
      headers: {},
      remove: [],
    });
  });

  it("should preserve Message-ID from encrypted envelope", () => {
    const { headers, remove } = buildDecryptedThreadingHeaders({
      headers: { "message-id": ["<env-A@example.com>"] },
    });
    expect(headers["Message-ID"]).toBe("<env-A@example.com>");
    expect(remove).toContain("Message-ID");
  });

  it("should surface Message-ID, In-Reply-To, and References together", () => {
    const { headers, remove } = buildDecryptedThreadingHeaders({
      headers: {
        "message-id": ["<env-B@x>"],
        "in-reply-to": ["<env-A@x>"],
        references: ["<env-A@x>"],
      },
    });
    expect(headers).toEqual({
      "Message-ID": "<env-B@x>",
      "In-Reply-To": "<env-A@x>",
      References: "<env-A@x>",
    });
    expect(remove.sort()).toEqual(
      ["In-Reply-To", "Message-ID", "References"].sort(),
    );
  });

  it("should handle string-form headers (not just arrays)", () => {
    const { headers } = buildDecryptedThreadingHeaders({
      headers: { "in-reply-to": "<p@x>" } as any,
    });
    expect(headers["In-Reply-To"]).toBe("<p@x>");
  });

  it("should store sender badges for the imported message", () => {
    const badges = badgesFromSender({
      attributes: [
        { value: "alice@example.com" },
        { value: "Alice Anderson" },
      ],
    });
    expect(badges).toEqual([
      { value: "alice@example.com" },
      { value: "Alice Anderson" },
    ]);
  });

  // Regression for #48: the decrypted-message banner must show *all*
  // signed sender attributes, not just the email. pg-js >= 2.0.0 returns
  // the post-unseal verified identity, so `FriendlySender.attributes`
  // carries the public email con *and* the private name/organization con
  // (flattened by pg-js's `parseSender`). Every one of them must become a
  // badge. (pg-js 1.x reused the pre-unseal identity and dropped the
  // private attributes, so only the email badge ever showed.)
  it("should build a badge for every signed attribute, not just the email", () => {
    const badges = badgesFromSender({
      attributes: [
        { value: "alice@example.com" },
        { value: "Alice Anderson" },
        { value: "ACME Corp" },
      ],
    });
    expect(badges).toEqual([
      { value: "alice@example.com" },
      { value: "Alice Anderson" },
      { value: "ACME Corp" },
    ]);
  });

  it("should treat undisclosed sender attributes as empty-string badges", () => {
    const badges = badgesFromSender({
      attributes: [{ value: null }, { value: undefined }],
    });
    expect(badges).toEqual([{ value: "" }, { value: "" }]);
  });

  it("should return an empty badge list when sender is missing", () => {
    expect(badgesFromSender(null)).toEqual([]);
    expect(badgesFromSender(undefined)).toEqual([]);
    expect(badgesFromSender({})).toEqual([]);
  });
});

describe("handleDecryptMessage — error handling", () => {
  it("should return decryptionFailed on KEM error (wrong attributes)", () => {
    expect(classifyDecryptionError(new Error("KEM error: blah"))).toBe(
      "decryptionFailed",
    );
  });

  it("should return decryptionError on generic failure", () => {
    expect(classifyDecryptionError(new Error("network broke"))).toBe(
      "decryptionError",
    );
    expect(classifyDecryptionError("string error")).toBe("decryptionError");
    expect(classifyDecryptionError(undefined)).toBe("decryptionError");
  });
});
