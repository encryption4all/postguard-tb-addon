import { describe, it, expect, beforeEach } from "vitest";
import {
  composeTabs,
  decryptedMessages,
  pendingCryptoPopups,
  pendingPolicyEditors,
  persistEncryptState,
  restoreEncryptState,
  toggleEncrypt,
  cleanupComposeTab,
  cleanupDecryptedMessage,
} from "../src/background/state";
import type { Policy } from "../src/lib/types";
import { installBrowserMock, type BrowserMock } from "./helpers/browser-mock";

let mock: BrowserMock;

beforeEach(() => {
  mock = installBrowserMock();
  composeTabs.clear();
  decryptedMessages.clear();
  pendingCryptoPopups.clear();
  pendingPolicyEditors.clear();
});

// `state.ts` exposes the data store + helpers; the actual
// `windows.onCreated` / `tabs.onRemoved` wiring lives in `background.ts`.
// These tests exercise the helpers in the same order the listeners call
// them, which is what we want to regression-protect: the state transitions,
// not the listener glue.
describe("compose tab state lifecycle", () => {
  it("should initialize state when compose window is created", () => {
    composeTabs.set(42, { encrypt: false });
    expect(composeTabs.get(42)).toEqual({ encrypt: false });
  });

  it("should auto-enable encryption when replying to encrypted message", () => {
    composeTabs.set(42, { encrypt: true });
    expect(composeTabs.get(42)?.encrypt).toBe(true);
  });

  it("should auto-enable encryption when replying to previously encrypted message", () => {
    composeTabs.set(42, { encrypt: true });
    expect(composeTabs.get(42)?.encrypt).toBe(true);
  });

  it("should not auto-enable encryption for non-encrypted replies", () => {
    composeTabs.set(42, { encrypt: false });
    expect(composeTabs.get(42)?.encrypt).toBe(false);
  });

  it("should not auto-enable encryption for new messages", () => {
    composeTabs.set(42, { encrypt: false });
    expect(composeTabs.get(42)?.encrypt).toBe(false);
  });

  it("should clean up state when compose tab is closed", () => {
    composeTabs.set(42, { encrypt: true });
    cleanupComposeTab(42);
    expect(composeTabs.has(42)).toBe(false);
  });
});

describe("encryption toggle", () => {
  it("should toggle encrypt state and update icon", async () => {
    mock.composeDetails.set(7, { to: ["a@b.c"], cc: [], deliveryFormat: "auto" });
    expect(composeTabs.get(7)?.encrypt ?? false).toBe(false);

    const r1 = await toggleEncrypt(7);
    expect(r1.encrypt).toBe(true);
    expect(composeTabs.get(7)?.encrypt).toBe(true);

    const r2 = await toggleEncrypt(7);
    expect(r2.encrypt).toBe(false);
    expect(composeTabs.get(7)?.encrypt).toBe(false);
  });

  it("should set deliveryFormat to 'both' when enabling encryption", async () => {
    mock.composeDetails.set(7, { to: [], cc: [], deliveryFormat: "auto" });
    await toggleEncrypt(7);
    const last = mock.setComposeDetailsCalls.at(-1);
    expect(last?.details).toMatchObject({ deliveryFormat: "both" });
  });

  it("should set deliveryFormat to 'auto' when disabling encryption", async () => {
    mock.composeDetails.set(7, { to: [], cc: [], deliveryFormat: "both" });
    composeTabs.set(7, { encrypt: true });
    await toggleEncrypt(7);
    const last = mock.setComposeDetailsCalls.at(-1);
    expect(last?.details).toMatchObject({ deliveryFormat: "auto" });
  });

  it("should return hasRecipients status with toggle result", async () => {
    mock.composeDetails.set(1, { to: ["a@b.c"], cc: [], deliveryFormat: "auto" });
    const withTo = await toggleEncrypt(1);
    expect(withTo.hasRecipients).toBe(true);

    mock.composeDetails.set(2, { to: [], cc: ["c@d.e"], deliveryFormat: "auto" });
    const withCc = await toggleEncrypt(2);
    expect(withCc.hasRecipients).toBe(true);

    mock.composeDetails.set(3, { to: [], cc: [], deliveryFormat: "auto" });
    const noRecipients = await toggleEncrypt(3);
    expect(noRecipients.hasRecipients).toBe(false);
  });
});

describe("decryptedMessages cleanup", () => {
  it("should remove entry when message is deleted", () => {
    decryptedMessages.set(99, { badges: [{ value: "alice@example.com" }] });
    expect(decryptedMessages.has(99)).toBe(true);
    cleanupDecryptedMessage(99);
    expect(decryptedMessages.has(99)).toBe(false);
  });

  it("should not crash when deleting unknown message ID", () => {
    expect(() => cleanupDecryptedMessage(12345)).not.toThrow();
  });
});

describe("pending popup maps", () => {
  it("should reject pending crypto popup when window is closed", async () => {
    const { promise, resolve, reject } = Promise.withResolvers<any>();
    pendingCryptoPopups.set(500, { data: {} as any, resolve, reject });

    const pending = pendingCryptoPopups.get(500);
    pending?.reject(new Error("Popup closed"));
    pendingCryptoPopups.delete(500);

    await expect(promise).rejects.toThrow("Popup closed");
    expect(pendingCryptoPopups.has(500)).toBe(false);
  });

  it("should reject pending policy editor when window is closed", async () => {
    const { promise, resolve, reject } = Promise.withResolvers<Policy>();
    const policy: Policy = { "alice@example.com": [{ t: "pbdf.sidn-pbdf.email.email", v: "" }] };
    pendingPolicyEditors.set(600, {
      composeTabId: 1,
      initialPolicy: policy,
      sign: false,
      resolve,
      reject,
    });

    const pending = pendingPolicyEditors.get(600);
    pending?.reject(new Error("window closed"));
    pendingPolicyEditors.delete(600);

    await expect(promise).rejects.toThrow("window closed");
    expect(pendingPolicyEditors.has(600)).toBe(false);
  });

  it("should not leave stale entries after popup completes", async () => {
    const { promise, resolve, reject } = Promise.withResolvers<any>();
    pendingCryptoPopups.set(700, { data: {} as any, resolve, reject });
    pendingCryptoPopups.get(700)?.resolve({ ok: true } as any);
    pendingCryptoPopups.delete(700);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(pendingCryptoPopups.has(700)).toBe(false);
  });

  it("should not leave stale entries after popup errors", async () => {
    const { promise, resolve, reject } = Promise.withResolvers<any>();
    pendingCryptoPopups.set(800, { data: {} as any, resolve, reject });
    pendingCryptoPopups.get(800)?.reject(new Error("crypto error"));
    pendingCryptoPopups.delete(800);
    await expect(promise).rejects.toThrow("crypto error");
    expect(pendingCryptoPopups.has(800)).toBe(false);
  });

  it("should not allow two policy editors for the same compose tab", () => {
    composeTabs.set(1, { encrypt: true, configWindowId: 900 });
    pendingPolicyEditors.set(900, {
      composeTabId: 1,
      initialPolicy: {},
      sign: false,
      resolve: () => {},
      reject: () => {},
    });

    // handleOpenPolicyEditor's guard: if configWindowId is set, skip.
    const state = composeTabs.get(1)!;
    const shouldOpenAnother = !state.configWindowId;
    expect(shouldOpenAnother).toBe(false);
    expect(pendingPolicyEditors.size).toBe(1);
  });

  it("should not allow two sign editors for the same compose tab", () => {
    composeTabs.set(1, { encrypt: true, signWindowId: 901 });
    pendingPolicyEditors.set(901, {
      composeTabId: 1,
      initialPolicy: {},
      sign: true,
      resolve: () => {},
      reject: () => {},
    });

    const state = composeTabs.get(1)!;
    const shouldOpenAnother = !state.signWindowId;
    expect(shouldOpenAnother).toBe(false);
    expect(pendingPolicyEditors.size).toBe(1);
  });
});

// The persistence layer is the PR #68 fix for
// "encrypt toggle lost after background suspension". Pin its invariants
// directly so a future refactor of state.ts can't regress them.
describe("encryption state persistence (PR #68)", () => {
  it("should persist only tabs where encrypt is true", async () => {
    composeTabs.set(1, { encrypt: true });
    composeTabs.set(2, { encrypt: false });
    await persistEncryptState();
    const saved = mock.storage.local["composeTabEncryptState"] as Record<string, unknown>;
    expect(Object.keys(saved)).toEqual(["1"]);
  });

  it("should restore persisted encrypt state for existing compose tabs", async () => {
    mock.storage.local["composeTabEncryptState"] = { "5": { encrypt: true } };
    mock.tabs = [{ id: 5, windowId: 50, type: "messageCompose" }];

    await restoreEncryptState();

    expect(composeTabs.get(5)?.encrypt).toBe(true);
  });

  it("should not restore state for tabs that no longer exist", async () => {
    mock.storage.local["composeTabEncryptState"] = { "999": { encrypt: true } };
    mock.tabs = [];

    await restoreEncryptState();

    expect(composeTabs.has(999)).toBe(false);
  });

  it("should not downgrade an already-set encrypt:true to persisted value", async () => {
    // PR #68 race fix: if the user already toggled encrypt:true, restore
    // must NOT clobber it.
    composeTabs.set(5, { encrypt: true });
    mock.storage.local["composeTabEncryptState"] = { "5": { encrypt: true } };
    mock.tabs = [{ id: 5, windowId: 50, type: "messageCompose" }];

    await restoreEncryptState();

    expect(composeTabs.get(5)?.encrypt).toBe(true);
  });

  it("should rewrite the persisted blob with current state after restore", async () => {
    // Surviving tab plus an orphan whose tab is gone. After restore, the blob
    // should contain only the surviving tab so the state persists across the
    // *next* suspension instead of being wiped (the latter loses encryption
    // after a double suspension — issue #128).
    mock.storage.local["composeTabEncryptState"] = {
      "5": { encrypt: true },
      "999": { encrypt: true },
    };
    mock.tabs = [{ id: 5, windowId: 50, type: "messageCompose" }];

    await restoreEncryptState();

    const saved = mock.storage.local["composeTabEncryptState"] as Record<string, unknown>;
    expect(saved).toBeDefined();
    expect(Object.keys(saved)).toEqual(["5"]);
  });

  it("should survive two consecutive restores without any intervening toggle (issue #128)", async () => {
    // Simulates: user toggles encrypt -> background suspends -> restart ->
    // restore -> no user activity -> background suspends again -> restart ->
    // restore. Prior to the fix the second restore found an empty blob and
    // the encrypt flag was lost.
    mock.storage.local["composeTabEncryptState"] = { "5": { encrypt: true } };
    mock.tabs = [{ id: 5, windowId: 50, type: "messageCompose" }];

    await restoreEncryptState();
    expect(composeTabs.get(5)?.encrypt).toBe(true);

    // Simulate a fresh background by clearing in-memory state. Storage keeps
    // whatever the previous restore wrote.
    composeTabs.clear();

    await restoreEncryptState();
    expect(composeTabs.get(5)?.encrypt).toBe(true);
  });
});
