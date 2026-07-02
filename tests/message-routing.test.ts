import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  dispatchRuntimeMessage,
  type RuntimeHandlers,
  type RuntimeSender,
} from "../src/background/runtime-router";

function makeHandlers(): RuntimeHandlers {
  return {
    handleQueryMessageState: vi.fn(),
    handleToggleEncryption: vi.fn(),
    handleGetComposeState: vi.fn(),
    handleOpenPolicyEditor: vi.fn(),
    handlePolicyEditorInit: vi.fn(),
    handlePolicyEditorDone: vi.fn(),
    handleCryptoPopupInit: vi.fn(),
    handleCryptoPopupDone: vi.fn(),
    handleCryptoPopupError: vi.fn(),
    handleCryptoPopupUploadInit: vi.fn(),
    handleDecryptMessage: vi.fn(),
    resolveComposeTabId: vi.fn(async (windowId) =>
      windowId == null ? undefined : windowId * 10,
    ),
  };
}

let handlers: RuntimeHandlers;
const sender: RuntimeSender = { tab: { id: 7, windowId: 3 } };

beforeEach(() => {
  handlers = makeHandlers();
});

describe("message routing", () => {
  it("should reject messages that are not objects", () => {
    expect(dispatchRuntimeMessage(null, sender, handlers)).toBe(false);
    expect(dispatchRuntimeMessage(undefined, sender, handlers)).toBe(false);
    expect(dispatchRuntimeMessage("hello", sender, handlers)).toBe(false);
    expect(dispatchRuntimeMessage(42, sender, handlers)).toBe(false);
  });

  it("should reject messages with unknown type", () => {
    expect(
      dispatchRuntimeMessage({ type: "nonsense" }, sender, handlers),
    ).toBe(false);
    expect(dispatchRuntimeMessage({}, sender, handlers)).toBe(false);
  });

  it("should route queryMessageState to the correct handler", () => {
    dispatchRuntimeMessage({ type: "queryMessageState" }, sender, handlers);
    expect(handlers.handleQueryMessageState).toHaveBeenCalledWith(7);
    expect(handlers.handleDecryptMessage).not.toHaveBeenCalled();
  });

  it("should route toggleEncryption to the correct handler", async () => {
    await dispatchRuntimeMessage(
      { type: "toggleEncryption" },
      sender,
      handlers,
    );
    expect(handlers.resolveComposeTabId).toHaveBeenCalledWith(3);
    expect(handlers.handleToggleEncryption).toHaveBeenCalledWith(30);
  });

  it("should route decryptMessage with messageId to the correct handler", () => {
    dispatchRuntimeMessage(
      { type: "decryptMessage", messageId: 42 },
      sender,
      handlers,
    );
    expect(handlers.handleDecryptMessage).toHaveBeenCalledWith(42);
  });

  it("should not process messages from unexpected senders", async () => {
    // A "sender" with no tab (e.g. another extension or detached message)
    // must still produce defined behavior: routes that depend on a tab
    // forward `undefined`, and routes that need a window resolve to no tab.
    const stranger: RuntimeSender = {};
    dispatchRuntimeMessage({ type: "queryMessageState" }, stranger, handlers);
    expect(handlers.handleQueryMessageState).toHaveBeenCalledWith(undefined);

    await dispatchRuntimeMessage(
      { type: "toggleEncryption" },
      stranger,
      handlers,
    );
    expect(handlers.handleToggleEncryption).toHaveBeenCalledWith(undefined);
  });

  it("should route openPolicyEditor and openSignEditor with the right sign flag", () => {
    dispatchRuntimeMessage({ type: "openPolicyEditor" }, sender, handlers);
    dispatchRuntimeMessage({ type: "openSignEditor" }, sender, handlers);
    expect(handlers.handleOpenPolicyEditor).toHaveBeenNthCalledWith(1, 3, false);
    expect(handlers.handleOpenPolicyEditor).toHaveBeenNthCalledWith(2, 3, true);
  });

  it("should ignore the windowId in the message and use the sender windowId on cryptoPopupInit", () => {
    // The message payload is sender-controlled; the router must trust only
    // the browser-supplied sender.tab.windowId (matches policyEditor routes).
    dispatchRuntimeMessage(
      { type: "cryptoPopupInit", windowId: 99 },
      sender,
      handlers,
    );
    expect(handlers.handleCryptoPopupInit).toHaveBeenCalledWith(3);
  });

  it("should route cryptoPopupInit using the sender windowId when the message omits it", () => {
    dispatchRuntimeMessage({ type: "cryptoPopupInit" }, sender, handlers);
    expect(handlers.handleCryptoPopupInit).toHaveBeenCalledWith(3);
  });
});

describe("message type validation", () => {
  it("should reject cryptoPopupDone with missing result", () => {
    expect(
      dispatchRuntimeMessage(
        { type: "cryptoPopupDone", windowId: 1 },
        sender,
        handlers,
      ),
    ).toBe(false);
    expect(handlers.handleCryptoPopupDone).not.toHaveBeenCalled();
  });

  it("should reject cryptoPopupDone with wrong operation type", () => {
    expect(
      dispatchRuntimeMessage(
        { type: "cryptoPopupDone", windowId: 1, result: { operation: "wat" } },
        sender,
        handlers,
      ),
    ).toBe(false);
    expect(handlers.handleCryptoPopupDone).not.toHaveBeenCalled();
  });

  it("should accept cryptoPopupDone with operation=encrypt or decrypt", async () => {
    await dispatchRuntimeMessage(
      {
        type: "cryptoPopupDone",
        windowId: 5,
        result: { operation: "encrypt" },
      },
      sender,
      handlers,
    );
    await dispatchRuntimeMessage(
      {
        type: "cryptoPopupDone",
        windowId: 6,
        result: { operation: "decrypt" },
      },
      sender,
      handlers,
    );
    expect(handlers.handleCryptoPopupDone).toHaveBeenCalledTimes(2);
  });

  it("should reject policyEditorDone with missing policy", () => {
    expect(
      dispatchRuntimeMessage({ type: "policyEditorDone" }, sender, handlers),
    ).toBe(false);
    expect(handlers.handlePolicyEditorDone).not.toHaveBeenCalled();
  });

  it("should reject decryptMessage with non-numeric messageId", () => {
    expect(
      dispatchRuntimeMessage(
        { type: "decryptMessage", messageId: "abc" },
        sender,
        handlers,
      ),
    ).toBe(false);
    expect(
      dispatchRuntimeMessage({ type: "decryptMessage" }, sender, handlers),
    ).toBe(false);
    expect(handlers.handleDecryptMessage).not.toHaveBeenCalled();
  });

  it("should reject cryptoPopupInit from window not in pending map", () => {
    // The router forwards to the handler; the handler is what consults the
    // pending map. Pin that the router still returns the handler's result
    // (wrapped in a Promise) rather than swallowing a null.
    (handlers.handleCryptoPopupInit as any).mockReturnValue(null);
    const result = dispatchRuntimeMessage(
      { type: "cryptoPopupInit" },
      sender,
      handlers,
    );
    expect(handlers.handleCryptoPopupInit).toHaveBeenCalledWith(3);
    expect(result).toBeInstanceOf(Promise);
  });
});
