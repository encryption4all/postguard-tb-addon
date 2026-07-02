import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildRecipients } from "../src/pages/yivi-popup/recipients";
import { runEncryptInPopup, YIVI_ELEMENT_SELECTOR } from "../src/pages/yivi-popup/encrypt-popup";
import { runDecryptInPopup } from "../src/pages/yivi-popup/decrypt-popup";
import { initCryptoPopup } from "../src/pages/yivi-popup/init-flow";
import { UploadSessionExpiredError } from "@e4a/pg-js";
import { toBase64, fromBase64 } from "../src/lib/encoding";
import type {
  SerializedRecipient,
  EncryptPopupData,
  DecryptPopupData,
} from "../src/lib/types";

interface FakeRecipient {
  kind: "email" | "emailDomain";
  email: string;
  extras: Array<{ t: string; v: string }>;
  extraAttribute(t: string, v: string): FakeRecipient;
}

function makeFactory() {
  const make = (kind: "email" | "emailDomain") => (email: string) => {
    const r: FakeRecipient = {
      kind,
      email,
      extras: [],
      extraAttribute(t, v) {
        r.extras.push({ t, v });
        return r;
      },
    };
    return r;
  };
  return {
    email: vi.fn(make("email")),
    emailDomain: vi.fn(make("emailDomain")),
  };
}

let factory: ReturnType<typeof makeFactory>;

beforeEach(() => {
  factory = makeFactory();
});

// --- Shared fake pg instance ---------------------------------------------

interface FakeYiviArgs {
  element?: string;
  senderEmail?: string;
  attributes?: { t: string; v: string }[];
}

function makeFakePg(envelopeOverrides: Record<string, unknown> = {}) {
  const yiviCalls: FakeYiviArgs[] = [];
  const encryptCalls: any[] = [];
  const envelopeCalls: any[] = [];
  const openCalls: any[] = [];
  const decryptCalls: any[] = [];

  const envelope = {
    subject: "[PostGuard] message",
    htmlBody: "<encrypted/>",
    plainTextBody: "encrypted",
    attachment: new Blob(["fake-att"]),
    tier: 1,
    uploadUuid: null,
    ...envelopeOverrides,
  };

  const pg: any = {
    recipient: makeFactory(),
    sign: {
      yivi: vi.fn((args: FakeYiviArgs) => {
        yiviCalls.push(args);
        return { kind: "yivi-marker", ...args };
      }),
    },
    encrypt: vi.fn((args: any) => {
      encryptCalls.push(args);
      return { kind: "sealed", ...args };
    }),
    email: {
      createEnvelope: vi.fn(async (args: any) => {
        envelopeCalls.push(args);
        return envelope;
      }),
    },
    open: vi.fn((args: any) => {
      openCalls.push(args);
      return {
        decrypt: vi.fn(async (decArgs: any) => {
          decryptCalls.push(decArgs);
          // Default returns data-mode result. Tests override.
          return { plaintext: new Uint8Array([1, 2, 3]), sender: { name: "alice" } };
        }),
      };
    }),
  };

  return { pg, yiviCalls, encryptCalls, envelopeCalls, openCalls, decryptCalls, envelope };
}

function makeRuntime() {
  return { sendMessage: vi.fn(async () => undefined) };
}

// --- recipients ----------------------------------------------------------

describe("crypto popup — recipients", () => {
  it("should rebuild typed recipients from serialized data", () => {
    const input: SerializedRecipient[] = [
      { type: "email", email: "a@example.com" },
      { type: "email", email: "b@example.com" },
    ];
    const out = buildRecipients(factory as any, input);
    expect(out).toHaveLength(2);
    expect(factory.email).toHaveBeenCalledTimes(2);
    expect(factory.emailDomain).not.toHaveBeenCalled();
  });

  it("should map customPolicy recipients with extraAttribute calls", () => {
    const input: SerializedRecipient[] = [
      {
        type: "email",
        email: "alice@example.com",
        policy: [
          { t: "pbdf.sidn-pbdf.email.email", v: "alice@example.com" },
          { t: "pbdf.gemeente.personalData.fullname", v: "Alice" },
          { t: "pbdf.pbdf.surfnet-2.id", v: "alice@uni.example" },
        ],
      },
    ];
    const out = buildRecipients(factory as any, input) as any as FakeRecipient[];
    expect(out[0].extras).toEqual([
      { t: "pbdf.gemeente.personalData.fullname", v: "Alice" },
      { t: "pbdf.pbdf.surfnet-2.id", v: "alice@uni.example" },
    ]);
  });

  it("should map emailDomain recipients with pg.recipient.emailDomain", () => {
    const input: SerializedRecipient[] = [
      { type: "emailDomain", email: "@example.com" },
    ];
    buildRecipients(factory as any, input);
    expect(factory.emailDomain).toHaveBeenCalledWith("@example.com");
    expect(factory.email).not.toHaveBeenCalled();
  });

  it("should map plain email recipients with pg.recipient.email", () => {
    const input: SerializedRecipient[] = [
      { type: "email", email: "plain@example.com" },
    ];
    buildRecipients(factory as any, input);
    expect(factory.email).toHaveBeenCalledWith("plain@example.com");
    expect(factory.emailDomain).not.toHaveBeenCalled();
  });

  it("should not call extraAttribute when no policy is set", () => {
    const input: SerializedRecipient[] = [
      { type: "email", email: "a@example.com" },
    ];
    const out = buildRecipients(factory as any, input) as any as FakeRecipient[];
    expect(out[0].extras).toEqual([]);
  });
});

// --- init ----------------------------------------------------------------

function makeUi() {
  return {
    operation: null as null | "encrypt" | "decrypt",
    loadingDone: false,
    error: null as string | null,
    setOperation(op: "encrypt" | "decrypt") {
      this.operation = op;
    },
    setLoadingDone() {
      this.loadingDone = true;
    },
    showError(msg: string) {
      this.error = msg;
    },
  };
}

function fakeData(operation: "encrypt" | "decrypt" = "encrypt"): any {
  const base = {
    config: { pkgUrl: "https://pkg.example", headers: {} },
  };
  if (operation === "encrypt") {
    return {
      operation,
      ...base,
      mimeDataBase64: toBase64(new Uint8Array([1, 2, 3])),
      recipients: [{ type: "email" as const, email: "a@b" }],
      senderEmail: "me@b",
      from: "me@b",
      senderAttributes: [],
    };
  }
  return {
    operation,
    ...base,
    ciphertextBase64: toBase64(new Uint8Array([4, 5, 6])),
    recipientEmail: "me@b",
  };
}

describe("crypto popup — initialization", () => {
  it("should request init data using its own window ID", async () => {
    const ui = makeUi();
    const requestInitData = vi.fn(async () => fakeData("encrypt"));
    const runEncrypt = vi.fn(async () => undefined);
    const runDecrypt = vi.fn(async () => undefined);
    await initCryptoPopup({
      resolveWindowId: async () => 42,
      requestInitData,
      createPg: () => ({} as any),
      runEncrypt,
      runDecrypt,
      sendError: async () => undefined,
      closeWindow: async () => undefined,
      ui,
      i18n: { getMessage: (k) => k },
      scheduleAutoClose: () => undefined,
    });
    expect(requestInitData).toHaveBeenCalledWith(42);
    expect(ui.operation).toBe("encrypt");
    expect(runEncrypt).toHaveBeenCalledTimes(1);
    expect(runDecrypt).not.toHaveBeenCalled();
  });

  it("should show error when window ID cannot be resolved", async () => {
    const ui = makeUi();
    const requestInitData = vi.fn(async () => fakeData());
    const createPg = vi.fn();
    await initCryptoPopup({
      resolveWindowId: async () => {
        throw new Error("no window");
      },
      requestInitData,
      createPg,
      runEncrypt: async () => undefined,
      runDecrypt: async () => undefined,
      sendError: async () => undefined,
      closeWindow: async () => undefined,
      ui,
      i18n: { getMessage: (k) => k },
    });
    expect(ui.error).toBe("Failed to get window ID.");
    expect(requestInitData).not.toHaveBeenCalled();
    expect(createPg).not.toHaveBeenCalled();
  });

  it("should show error when no pending entry exists in background", async () => {
    const ui = makeUi();
    const createPg = vi.fn();
    await initCryptoPopup({
      resolveWindowId: async () => 7,
      requestInitData: async () => null,
      createPg,
      runEncrypt: async () => undefined,
      runDecrypt: async () => undefined,
      sendError: async () => undefined,
      closeWindow: async () => undefined,
      ui,
      i18n: { getMessage: (k) => k },
    });
    expect(ui.error).toBe("Failed to initialize session.");
    expect(createPg).not.toHaveBeenCalled();
  });

  it("should create PostGuard instance with config from background", async () => {
    const ui = makeUi();
    const data = fakeData("encrypt");
    const createPg = vi.fn(() => ({} as any));
    await initCryptoPopup({
      resolveWindowId: async () => 1,
      requestInitData: async () => data,
      createPg,
      runEncrypt: async () => undefined,
      runDecrypt: async () => undefined,
      sendError: async () => undefined,
      closeWindow: async () => undefined,
      ui,
      i18n: { getMessage: (k) => k },
      scheduleAutoClose: () => undefined,
    });
    expect(createPg).toHaveBeenCalledWith(data.config);
  });
});

// --- encrypt -------------------------------------------------------------

describe("crypto popup — encrypt", () => {
  it("should decode mimeDataBase64 before passing to SDK", async () => {
    const { pg, encryptCalls } = makeFakePg();
    const runtime = makeRuntime();
    const bytes = new Uint8Array([10, 20, 30, 40]);
    const data: EncryptPopupData = {
      operation: "encrypt",
      config: { pkgUrl: "p", headers: {} },
      mimeDataBase64: toBase64(bytes),
      recipients: [{ type: "email", email: "a@b" }],
      senderEmail: "me@b",
      from: "me@b",
    };
    await runEncryptInPopup(pg, data, 1, { runtime });
    expect(encryptCalls).toHaveLength(1);
    expect(Array.from(encryptCalls[0].data as Uint8Array)).toEqual([10, 20, 30, 40]);
  });

  it("should pass element selector for Yivi QR rendering", async () => {
    const { pg, yiviCalls } = makeFakePg();
    const runtime = makeRuntime();
    await runEncryptInPopup(pg, fakeData("encrypt"), 1, { runtime });
    expect(yiviCalls[0].element).toBe(YIVI_ELEMENT_SELECTOR);
    expect(yiviCalls[0].element).toBe("#yivi-web-form");
  });

  it("should send encrypt result back to background with correct windowId", async () => {
    const { pg } = makeFakePg();
    const runtime = makeRuntime();
    await runEncryptInPopup(pg, fakeData("encrypt"), 99, { runtime });
    const done = runtime.sendMessage.mock.calls
      .map((c) => c[0] as any)
      .find((m) => m.type === "cryptoPopupDone");
    expect(done).toBeDefined();
    expect(done.windowId).toBe(99);
    expect(done.result.operation).toBe("encrypt");
  });

  it("should include attachment size in result for size-gating", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])]);
    const { pg } = makeFakePg({ attachment: blob });
    const runtime = makeRuntime();
    await runEncryptInPopup(pg, fakeData("encrypt"), 1, { runtime });
    const done = runtime.sendMessage.mock.calls
      .map((c) => c[0] as any)
      .find((m) => m.type === "cryptoPopupDone");
    expect(done.result.attachmentSize).toBe(5);
    expect(typeof done.result.attachmentBase64).toBe("string");
  });

  it("should auto-close popup after successful encryption", async () => {
    // Auto-close is the init-flow's responsibility — pin that it
    // schedules a close exactly once when the operation resolves.
    const ui = makeUi();
    const data = fakeData("encrypt");
    const closes: number[] = [];
    const scheduled: Array<() => void> = [];
    await initCryptoPopup({
      resolveWindowId: async () => 5,
      requestInitData: async () => data,
      createPg: () => ({} as any),
      runEncrypt: async () => undefined,
      runDecrypt: async () => undefined,
      sendError: async () => undefined,
      closeWindow: async (id) => {
        closes.push(id);
      },
      ui,
      i18n: { getMessage: (k) => k },
      scheduleAutoClose: (fn) => scheduled.push(fn),
      autoCloseDelayMs: 0,
    });
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    await Promise.resolve();
    expect(closes).toEqual([5]);
  });
});

// --- decrypt -------------------------------------------------------------

describe("crypto popup — decrypt", () => {
  it("should decode ciphertextBase64 before passing to SDK", async () => {
    const { pg, openCalls } = makeFakePg();
    const runtime = makeRuntime();
    const bytes = new Uint8Array([7, 8, 9, 10]);
    const data: DecryptPopupData = {
      operation: "decrypt",
      config: { pkgUrl: "p", headers: {} },
      ciphertextBase64: toBase64(bytes),
      recipientEmail: "me@b",
    };
    await runDecryptInPopup(pg, data, 1, { runtime });
    expect(openCalls).toHaveLength(1);
    expect(Array.from(openCalls[0].data as Uint8Array)).toEqual([7, 8, 9, 10]);
  });

  it("should pass recipient email to SDK for key selection", async () => {
    const { pg, decryptCalls } = makeFakePg();
    const runtime = makeRuntime();
    const data: DecryptPopupData = {
      operation: "decrypt",
      config: { pkgUrl: "p", headers: {} },
      ciphertextBase64: toBase64(new Uint8Array([1])),
      recipientEmail: "alice@example.com",
    };
    await runDecryptInPopup(pg, data, 1, { runtime });
    expect(decryptCalls[0].recipient).toBe("alice@example.com");
  });

  it("should pass element selector for Yivi QR rendering", async () => {
    const { pg, decryptCalls } = makeFakePg();
    const runtime = makeRuntime();
    await runDecryptInPopup(pg, fakeData("decrypt"), 1, { runtime });
    expect(decryptCalls[0].element).toBe(YIVI_ELEMENT_SELECTOR);
  });

  it("should send decrypt result back to background with correct windowId", async () => {
    const { pg } = makeFakePg();
    const runtime = makeRuntime();
    await runDecryptInPopup(pg, fakeData("decrypt"), 77, { runtime });
    const done = runtime.sendMessage.mock.calls
      .map((c) => c[0] as any)
      .find((m) => m.type === "cryptoPopupDone");
    expect(done).toBeDefined();
    expect(done.windowId).toBe(77);
    expect(done.result.operation).toBe("decrypt");
  });

  it("should include sender identity in result", async () => {
    const { pg } = makeFakePg();
    const runtime = makeRuntime();
    await runDecryptInPopup(pg, fakeData("decrypt"), 1, { runtime });
    const done = runtime.sendMessage.mock.calls
      .map((c) => c[0] as any)
      .find((m) => m.type === "cryptoPopupDone");
    expect(done.result.sender).toEqual({ name: "alice" });
    // The plaintext payload is preserved through base64 round-trip.
    expect(Array.from(fromBase64(done.result.plaintextBase64))).toEqual([1, 2, 3]);
  });

  // Regression for #48: the popup must forward the *entire* sender
  // identity (every signed attribute) to the background untouched — the
  // banner can only show what it receives here. pg-js >= 2.0.0 surfaces
  // the post-unseal verified identity, so `sender.attributes` carries the
  // public email plus any private name/organization attributes. Guard
  // against the popup truncating that down to the email.
  it("should forward all sender attributes (email + name + org) untouched", async () => {
    const sender = {
      email: "alice@example.com",
      attributes: [
        { type: "pbdf.sidn-pbdf.email.email", value: "alice@example.com" },
        { type: "pbdf.gemeente.personalData.fullname", value: "Alice Anderson" },
        { type: "pbdf.pbdf.surfnet-2.institute", value: "ACME Corp" },
      ],
      raw: {
        public: { con: [{ t: "pbdf.sidn-pbdf.email.email", v: "alice@example.com" }] },
        private: {
          con: [
            { t: "pbdf.gemeente.personalData.fullname", v: "Alice Anderson" },
            { t: "pbdf.pbdf.surfnet-2.institute", v: "ACME Corp" },
          ],
        },
      },
    };
    const pg: any = {
      open: vi.fn(() => ({
        decrypt: vi.fn(async () => ({
          plaintext: new Uint8Array([1, 2, 3]),
          sender,
        })),
      })),
    };
    const runtime = makeRuntime();
    const data: any = {
      operation: "decrypt",
      ciphertextBase64: toBase64(new Uint8Array([9])),
      recipientEmail: "alice@example.com",
    };
    await runDecryptInPopup(pg, data, 1, { runtime });
    const done = runtime.sendMessage.mock.calls
      .map((c) => c[0] as any)
      .find((m) => m.type === "cryptoPopupDone");
    expect(done.result.sender).toEqual(sender);
    expect(done.result.sender.attributes).toHaveLength(3);
  });

  it("should auto-close popup after successful decryption", async () => {
    const ui = makeUi();
    const data = fakeData("decrypt");
    const closes: number[] = [];
    const scheduled: Array<() => void> = [];
    await initCryptoPopup({
      resolveWindowId: async () => 12,
      requestInitData: async () => data,
      createPg: () => ({} as any),
      runEncrypt: async () => undefined,
      runDecrypt: async () => undefined,
      sendError: async () => undefined,
      closeWindow: async (id) => {
        closes.push(id);
      },
      ui,
      i18n: { getMessage: (k) => k },
      scheduleAutoClose: (fn) => scheduled.push(fn),
      autoCloseDelayMs: 0,
    });
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    await Promise.resolve();
    expect(closes).toEqual([12]);
  });

  it("should pass tier-3 uuid through to pg.open and unzip the blob", async () => {
    // Pin the uuid branch: pg.open is called with `{ uuid }` and the
    // resulting blob is unwrapped via extractFromZip with "data.bin".
    const decryptCalls: any[] = [];
    const blob = new Blob(["fake-zip"]);
    const pg: any = {
      open: vi.fn(() => ({
        decrypt: vi.fn(async (args: any) => {
          decryptCalls.push(args);
          return { blob, sender: { name: "alice" } };
        }),
      })),
    };
    const runtime = makeRuntime();
    const extract = vi.fn(async (_b: Blob, name: string) => {
      expect(name).toBe("data.bin");
      return new Uint8Array([99]);
    });
    const data: DecryptPopupData = {
      operation: "decrypt",
      config: { pkgUrl: "p", headers: {} },
      uuid: "the-uuid",
      recipientEmail: "me@b",
    };
    await runDecryptInPopup(pg, data, 3, { runtime, extractFromZip: extract });
    expect(pg.open).toHaveBeenCalledWith({ uuid: "the-uuid" });
    expect(extract).toHaveBeenCalledTimes(1);
  });
});

// --- error handling ------------------------------------------------------

describe("crypto popup — error handling", () => {
  it("should send error message to background on encrypt failure", async () => {
    const ui = makeUi();
    const data = fakeData("encrypt");
    const sendError = vi.fn(async () => undefined);
    await initCryptoPopup({
      resolveWindowId: async () => 8,
      requestInitData: async () => data,
      createPg: () => ({} as any),
      runEncrypt: async () => {
        // Raw SDK text (could embed internal URLs/subsystem names).
        throw new Error("encrypt boom https://pkg.internal:8443/v2/parameters");
      },
      runDecrypt: async () => undefined,
      sendError,
      closeWindow: async () => undefined,
      ui,
      i18n: { getMessage: (k) => k },
      scheduleAutoClose: () => undefined,
    });
    // The raw message is sanitized to the generic fallback key, never
    // the SDK text.
    expect(sendError).toHaveBeenCalledWith(8, "operationFailed");
  });

  it("should send error message to background on decrypt failure", async () => {
    const ui = makeUi();
    const data = fakeData("decrypt");
    const sendError = vi.fn(async () => undefined);
    await initCryptoPopup({
      resolveWindowId: async () => 9,
      requestInitData: async () => data,
      createPg: () => ({} as any),
      runEncrypt: async () => undefined,
      runDecrypt: async () => {
        throw new Error("decrypt boom internal-keyserver-down");
      },
      sendError,
      closeWindow: async () => undefined,
      ui,
      i18n: { getMessage: (k) => k },
      scheduleAutoClose: () => undefined,
    });
    expect(sendError).toHaveBeenCalledWith(9, "operationFailed");
  });

  it("should display error in popup UI", async () => {
    const ui = makeUi();
    const data = fakeData("encrypt");
    await initCryptoPopup({
      resolveWindowId: async () => 1,
      requestInitData: async () => data,
      createPg: () => ({} as any),
      runEncrypt: async () => {
        throw new Error("UI boom");
      },
      runDecrypt: async () => undefined,
      sendError: async () => undefined,
      closeWindow: async () => undefined,
      ui,
      i18n: { getMessage: (k) => k },
      scheduleAutoClose: () => undefined,
    });
    expect(ui.error).toBe("operationFailed");
  });

  it("should not auto-close on error", async () => {
    const ui = makeUi();
    const data = fakeData("encrypt");
    const scheduled: Array<() => void> = [];
    await initCryptoPopup({
      resolveWindowId: async () => 1,
      requestInitData: async () => data,
      createPg: () => ({} as any),
      runEncrypt: async () => {
        throw new Error("nope");
      },
      runDecrypt: async () => undefined,
      sendError: async () => undefined,
      closeWindow: async () => undefined,
      ui,
      i18n: { getMessage: (k) => k },
      scheduleAutoClose: (fn) => scheduled.push(fn),
    });
    expect(scheduled).toEqual([]);
  });

  // Regression for #143: raw SDK error text (which can embed internal
  // server URLs or subsystem names) must never reach the UI or the
  // background — only the generic localized fallback should.
  it("should never leak raw SDK error text to UI or background", async () => {
    const ui = makeUi();
    const data = fakeData("encrypt");
    const sendError = vi.fn(async () => undefined);
    const leaky = "boom at https://pkg.internal:8443/v2/parameters (keyserver)";
    await initCryptoPopup({
      resolveWindowId: async () => 1,
      requestInitData: async () => data,
      createPg: () => ({} as any),
      runEncrypt: async () => {
        throw new Error(leaky);
      },
      runDecrypt: async () => undefined,
      sendError,
      closeWindow: async () => undefined,
      ui,
      i18n: { getMessage: (k) => k },
      scheduleAutoClose: () => undefined,
    });
    expect(ui.error).toBe("operationFailed");
    expect(sendError).toHaveBeenCalledWith(1, "operationFailed");
    expect(ui.error).not.toContain("pkg.internal");
    expect(sendError.mock.calls[0][1]).not.toContain("pkg.internal");
  });

  // UploadSessionExpiredError is an explicitly safe type: its dedicated
  // localized message is user-facing and carries no internal detail, so
  // it is allowed through (mapped to its own i18n key).
  it("should map UploadSessionExpiredError to its safe localized key", async () => {
    const ui = makeUi();
    const data = fakeData("encrypt");
    const sendError = vi.fn(async () => undefined);
    await initCryptoPopup({
      resolveWindowId: async () => 4,
      requestInitData: async () => data,
      createPg: () => ({} as any),
      runEncrypt: async () => {
        throw new UploadSessionExpiredError("session gone");
      },
      runDecrypt: async () => undefined,
      sendError,
      closeWindow: async () => undefined,
      ui,
      i18n: { getMessage: (k) => k },
      scheduleAutoClose: () => undefined,
    });
    expect(ui.error).toBe("uploadSessionExpired");
    expect(sendError).toHaveBeenCalledWith(4, "uploadSessionExpired");
  });
});
