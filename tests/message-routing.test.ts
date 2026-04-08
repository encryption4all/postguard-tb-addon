import { describe, it, expect } from "vitest";

// These tests verify the background script's message routing logic.
// They require a browser API mock to be implemented.

describe("message routing", () => {
  it.todo("should reject messages that are not objects");

  it.todo("should reject messages with unknown type");

  it.todo("should route queryMessageState to the correct handler");

  it.todo("should route toggleEncryption to the correct handler");

  it.todo("should route decryptMessage with messageId to the correct handler");

  it.todo("should not process messages from unexpected senders");
});

describe("message type validation", () => {
  it.todo("should reject cryptoPopupDone with missing result");

  it.todo("should reject cryptoPopupDone with wrong operation type");

  it.todo("should reject policyEditorDone with missing policy");

  it.todo("should reject decryptMessage with non-numeric messageId");

  it.todo("should reject cryptoPopupInit from window not in pending map");
});
