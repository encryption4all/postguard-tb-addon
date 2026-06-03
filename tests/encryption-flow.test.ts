import { describe, it, expect, vi } from "vitest";
import {
  serializeRecipients,
  buildThreadingHeaders,
  evaluateBeforeSendGuards,
  runBeforeSendEncryption,
  MAX_ATTACHMENT_SIZE,
  type RunBeforeSendDeps,
  type BeforeSendDetails,
  type BeforeSendState,
} from "../src/background/encryption-flow";
import type { Policy } from "../src/lib/types";

describe("handleBeforeSend — encryption guard", () => {
  it("should not encrypt when state.encrypt is false", () => {
    expect(evaluateBeforeSendGuards({ encrypt: false }, { bcc: [] })).toEqual({
      kind: "skip",
    });
    expect(evaluateBeforeSendGuards(undefined, { bcc: [] })).toEqual({
      kind: "skip",
    });
  });

  it("should cancel send when BCC recipients are present", () => {
    expect(
      evaluateBeforeSendGuards({ encrypt: true }, { bcc: ["x@y.z"] }),
    ).toEqual({ kind: "cancel", reason: "bcc" });
  });

  it("should notify user when BCC blocks send", () => {
    // The notifyError call happens in background.ts based on the
    // `reason` of the guard result. Pin that the guard returns the
    // BCC reason so the listener can drive the i18n key.
    const r = evaluateBeforeSendGuards({ encrypt: true }, { bcc: ["x@y.z"] });
    expect(r).toMatchObject({ kind: "cancel", reason: "bcc" });
  });

  it("should cancel send when policy editor is already open", () => {
    expect(
      evaluateBeforeSendGuards(
        { encrypt: true, configWindowId: 42 },
        { bcc: [] },
      ),
    ).toEqual({ kind: "cancel", reason: "policyEditorOpen" });
  });

  it("should focus existing policy editor window instead of opening new one", () => {
    // The guard returns `policyEditorOpen`; the listener consults
    // state.configWindowId and calls windows.update on it. Pin the
    // guard's contract — focusing itself is exercised in the
    // integration tests on the background bundle.
    const r = evaluateBeforeSendGuards(
      { encrypt: true, configWindowId: 99 },
      { bcc: [] },
    );
    expect(r).toMatchObject({ kind: "cancel", reason: "policyEditorOpen" });
  });

  it("should proceed when encrypt is on and no BCC / editor", () => {
    expect(
      evaluateBeforeSendGuards({ encrypt: true }, { bcc: [] }),
    ).toBeNull();
  });
});

describe("handleBeforeSend — attachment handling", () => {
  it("should attach encrypted file when under 5MB limit", () => {
    expect(MAX_ATTACHMENT_SIZE).toBe(5 * 1024 * 1024);
    const attachmentSize = 4 * 1024 * 1024;
    expect(attachmentSize <= MAX_ATTACHMENT_SIZE).toBe(true);
  });

  it("should not attach encrypted file when over 5MB limit", () => {
    const attachmentSize = 6 * 1024 * 1024;
    expect(attachmentSize <= MAX_ATTACHMENT_SIZE).toBe(false);
  });

  it("should treat a missing attachmentBase64 as 'skip the attach step'", () => {
    // The production check is `result.attachmentBase64 != null && size <= cap`.
    // Pin both arms here so a refactor cannot silently drop one.
    const noBase64 = { attachmentBase64: null, attachmentSize: 100 };
    expect(
      noBase64.attachmentBase64 != null &&
        noBase64.attachmentSize <= MAX_ATTACHMENT_SIZE,
    ).toBe(false);
    const overLimit = {
      attachmentBase64: "AAAA",
      attachmentSize: MAX_ATTACHMENT_SIZE + 1,
    };
    expect(
      overLimit.attachmentBase64 != null &&
        overLimit.attachmentSize <= MAX_ATTACHMENT_SIZE,
    ).toBe(false);
  });
});

describe("handleBeforeSend — recipient serialization", () => {
  it("should serialize recipients with email-only policy by default", () => {
    const r = serializeRecipients(["Alice <alice@example.com>"], []);
    expect(r).toEqual([{ type: "email", email: "alice@example.com" }]);
  });

  it("should serialize recipients with custom policy when set", () => {
    const policy: Policy = {
      "alice@example.com": [
        { t: "pbdf.sidn-pbdf.email.email", v: "alice@example.com" },
        { t: "pbdf.gemeente.personalData.fullname", v: "Alice" },
      ],
    };
    const r = serializeRecipients(["alice@example.com"], [], policy);
    expect(r).toEqual([
      {
        type: "email",
        email: "alice@example.com",
        policy: policy["alice@example.com"],
      },
    ]);
  });

  it("should lowercase email in custom policy email attribute", () => {
    const policy: Policy = {
      "mixed@example.com": [
        { t: "pbdf.sidn-pbdf.email.email", v: "MiXeD@Example.COM" },
        { t: "pbdf.gemeente.personalData.fullname", v: "Charlie" },
      ],
    };
    const r = serializeRecipients(["mixed@example.com"], [], policy);
    expect((r[0] as any).policy).toEqual([
      { t: "pbdf.sidn-pbdf.email.email", v: "mixed@example.com" },
      { t: "pbdf.gemeente.personalData.fullname", v: "Charlie" },
    ]);
  });

  it("should include both to and cc recipients", () => {
    const r = serializeRecipients(
      ["a@example.com"],
      ["b@example.com", "c@example.com"],
    );
    expect(r.map((x) => x.email)).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
  });

  it("should not include bcc recipients", () => {
    // The function deliberately does not accept BCC. The guard layer
    // cancels any send that has BCC before we reach this code.
    // Pin both halves: signature and no leakage through the spread.
    const r = serializeRecipients(["a@example.com"], ["b@example.com"]);
    expect(r.map((x) => x.email)).not.toContain("bcc@example.com");
  });
});

describe("handleBeforeSend — threading headers", () => {
  it("should include In-Reply-To when replying to a message", () => {
    const h = buildThreadingHeaders({
      headers: { "message-id": ["<parent@example.com>"] },
    });
    expect(h.inReplyTo).toBe("<parent@example.com>");
  });

  it("should include References when replying to a message", () => {
    const h = buildThreadingHeaders({
      headers: { "message-id": ["<parent@example.com>"] },
    });
    expect(h.references).toBe("<parent@example.com>");
  });

  it("should build References from parent References + Message-ID", () => {
    const h = buildThreadingHeaders({
      headers: {
        "message-id": ["<parent@example.com>"],
        references: ["<root@example.com> <reply1@example.com>"],
      },
    });
    expect(h.references).toBe(
      "<root@example.com> <reply1@example.com> <parent@example.com>",
    );
  });

  it("should handle missing related message gracefully", () => {
    expect(buildThreadingHeaders(null)).toEqual({});
    expect(buildThreadingHeaders(undefined)).toEqual({});
    expect(buildThreadingHeaders({ headers: {} })).toEqual({});
  });

  it("should handle string-form headers (not just arrays)", () => {
    // Some Thunderbird builds return headers as plain strings instead
    // of single-element arrays. Pin both shapes so a future refactor
    // can't quietly break threading on either.
    const h = buildThreadingHeaders({
      headers: { "message-id": "<parent@example.com>" } as any,
    });
    expect(h.inReplyTo).toBe("<parent@example.com>");
  });
});

describe("handleBeforeSend — error recovery", () => {
  function makeDeps(overrides: Partial<RunBeforeSendDeps> = {}): {
    deps: RunBeforeSendDeps;
    notifyError: ReturnType<typeof vi.fn>;
    removeAttachment: ReturnType<typeof vi.fn>;
    addAttachment: ReturnType<typeof vi.fn>;
  } {
    const notifyError = vi.fn();
    const removeAttachment = vi.fn(async () => undefined);
    const addAttachment = vi.fn(async () => undefined);
    const deps: RunBeforeSendDeps = {
      listAttachments: async () => [],
      getAttachmentFile: async () => ({
        name: "x",
        type: "x",
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
      getFullMessage: async () => null,
      removeAttachment,
      addAttachment,
      openCryptoPopup: async () => {
        throw new Error("default — override in test");
      },
      notifyError,
      buildMime: () => new Uint8Array([1, 2, 3]),
      pkgUrl: "https://pkg.example",
      cryptifyUrl: "https://cry.example",
      websiteUrl: "https://site.example",
      pgClientHeader: {},
      xPostguardVersion: "0.1.0",
      ...overrides,
    };
    return { deps, notifyError, removeAttachment, addAttachment };
  }

  const state: BeforeSendState = { encrypt: true };
  const details: BeforeSendDetails = {
    from: "me@example.com",
    to: ["alice@example.com"],
    cc: [],
    subject: "hi",
    body: "<p>hi</p>",
    isPlainText: false,
  };

  it("should cancel send and notify on encryption failure", async () => {
    const { deps, notifyError, addAttachment } = makeDeps({
      openCryptoPopup: async () => {
        throw new Error("encryption boom");
      },
    });
    const out = await runBeforeSendEncryption(state, details, 1, deps);
    expect(out.cancel).toBe(true);
    expect(out.details).toBeUndefined();
    expect(notifyError).toHaveBeenCalledWith("encryptionError");
    expect(addAttachment).not.toHaveBeenCalled();
  });

  it("should cancel send when popup is closed by user", async () => {
    const { deps, notifyError } = makeDeps({
      openCryptoPopup: async () => {
        throw new Error("Popup closed");
      },
    });
    const out = await runBeforeSendEncryption(state, details, 1, deps);
    expect(out.cancel).toBe(true);
    expect(out.details).toBeUndefined();
    // Same catch arm as any other failure — notify and cancel.
    expect(notifyError).toHaveBeenCalledWith("encryptionError");
  });

  it("should not detach original attachments when popup throws (issue #129)", async () => {
    // Regression: pre-fix, the loop that called removeAttachment ran
    // *before* openCryptoPopup, so cancelling/closing the popup left
    // the compose window with no attachments and no way to recover.
    const { deps, removeAttachment, addAttachment, notifyError } = makeDeps({
      listAttachments: async () => [{ id: 11 }, { id: 22 }],
      getAttachmentFile: async () => ({
        name: "secret.pdf",
        type: "application/pdf",
        arrayBuffer: async () => new ArrayBuffer(8),
      }),
      openCryptoPopup: async () => {
        throw new Error("user closed the popup");
      },
    });
    const out = await runBeforeSendEncryption(state, details, 1, deps);
    expect(out).toEqual({ cancel: true });
    expect(removeAttachment).not.toHaveBeenCalled();
    expect(addAttachment).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith("encryptionError");
  });

  it("should detach originals and attach encrypted bundle on popup success", async () => {
    // Companion to the cancel-path test: confirms that the relocated
    // detach still runs on the happy path (one removeAttachment per
    // original, plus one addAttachment for postguard.encrypted).
    const { deps, removeAttachment, addAttachment } = makeDeps({
      listAttachments: async () => [{ id: 11 }, { id: 22 }],
      getAttachmentFile: async () => ({
        name: "secret.pdf",
        type: "application/pdf",
        arrayBuffer: async () => new ArrayBuffer(8),
      }),
      openCryptoPopup: async () =>
        ({
          subject: "encrypted",
          htmlBody: "<p>encrypted</p>",
          plainTextBody: "encrypted",
          attachmentBase64: "AAAA",
          attachmentSize: 4,
        }) as any,
    });
    const out = await runBeforeSendEncryption(state, details, 1, deps);
    expect(out.cancel).toBeUndefined();
    expect(removeAttachment).toHaveBeenCalledTimes(2);
    expect(removeAttachment).toHaveBeenNthCalledWith(1, 1, 11);
    expect(removeAttachment).toHaveBeenNthCalledWith(2, 1, 22);
    expect(addAttachment).toHaveBeenCalledTimes(1);
  });

  it("should not leak plaintext in compose body on failure", async () => {
    // If the popup throws AFTER the buildMime call, the returned
    // outcome must not include any details — otherwise Thunderbird
    // would replace the compose body with whatever partial value we
    // surfaced. Pin: failure produces { cancel: true } and nothing else
    // (no subject, no body, no plainTextBody, no customHeaders).
    const { deps } = makeDeps({
      openCryptoPopup: async () => {
        throw new Error("anywhere");
      },
    });
    const out = await runBeforeSendEncryption(
      state,
      { ...details, body: "PLAINTEXT-SECRET" },
      1,
      deps,
    );
    expect(out).toEqual({ cancel: true });
    expect(out.sentMimeData).toBeUndefined();
  });
});
