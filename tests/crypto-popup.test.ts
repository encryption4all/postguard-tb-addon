import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildRecipients } from "../src/pages/yivi-popup/recipients";
import type { SerializedRecipient } from "../src/lib/types";

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

describe("crypto popup — initialization", () => {
  it.todo("should request init data using its own window ID");
  it.todo("should show error when window ID cannot be resolved");
  it.todo("should show error when no pending entry exists in background");
  it.todo("should create PostGuard instance with config from background");
});

describe("crypto popup — encrypt", () => {
  it.todo("should decode mimeDataBase64 before passing to SDK");

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
    // The email attribute is the implicit identity and must NOT be
    // re-added via extraAttribute.
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

  it.todo("should pass element selector for Yivi QR rendering");
  it.todo("should send encrypt result back to background with correct windowId");
  it.todo("should include attachment size in result for size-gating");
  it.todo("should auto-close popup after successful encryption");
});

describe("crypto popup — decrypt", () => {
  it.todo("should decode ciphertextBase64 before passing to SDK");
  it.todo("should pass recipient email to SDK for key selection");
  it.todo("should pass element selector for Yivi QR rendering");
  it.todo("should send decrypt result back to background with correct windowId");
  it.todo("should include sender identity in result");
  it.todo("should auto-close popup after successful decryption");
});

describe("crypto popup — error handling", () => {
  it.todo("should send error message to background on encrypt failure");
  it.todo("should send error message to background on decrypt failure");
  it.todo("should display error in popup UI");
  it.todo("should not auto-close on error");
});
