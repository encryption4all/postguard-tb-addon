/// <reference path="../types/thunderbird.d.ts" />

import { buildMime, extractCiphertext, extractUploadUuid, injectMimeHeaders, resumeUpload, UploadSessionExpiredError } from "@e4a/pg-js";
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
  inFlightUploads,
  recordInFlightUpload,
  clearInFlightUpload,
  persistInFlightUploads,
  loadInFlightUploads,
} from "./state";
import { PKG_URL, CRYPTIFY_URL, POSTGUARD_WEBSITE_URL } from "../lib/pkg-client";
import { toBase64, fromBase64 } from "../lib/encoding";
import { toEmail, EMAIL_ATTRIBUTE_TYPE, findHtmlBody } from "../lib/utils";
import { getOrCreateLocalFolder } from "../lib/folders";
import { isPGEncrypted, wasPGEncrypted } from "../lib/detection";
import { dispatchRuntimeMessage } from "./runtime-router";
import { handleAfterSend } from "./sent-copy";
import {
  evaluateBeforeSendGuards,
  runBeforeSendEncryption,
} from "./encryption-flow";
import {
  buildDecryptedThreadingHeaders,
  classifyDecryptionError,
  badgesFromSender,
  pickRecipientEmail,
  chooseDecryptionInput,
} from "./decryption-flow";
import type {
  Policy,
  SerializedRecipient,
  CryptoPopupInitData,
  CryptoPopupResult,
  EncryptPopupResult,
  DecryptPopupResult,
} from "../lib/types";

function notifyError(messageKey: string) {
  browser.notifications.create({
    type: "basic",
    title: "PostGuard",
    message: browser.i18n.getMessage(messageKey),
  });
}

// Populated after listeners are registered (see bottom of file).
// All code that uses this runs in response to user actions, so it is
// always set by the time it is read.
export let PG_CLIENT_HEADER: Record<string, string> = {};

// Internet header flagged on outgoing encrypted messages. The Outlook add-in's
// OnMessageRead launch event filters on `HeaderName="x-postguard"`; keeping
// this value aligned with the Outlook compose flow and cryptify so a single
// filter matches mail from all three senders. See postguard-tb-addon#52.
const X_POSTGUARD_VERSION = "0.1.0";

// --- Module-level state ---
// pendingPolicyEditors and pendingCryptoPopups live in ./state so unit tests
// can observe map churn (open / resolve / reject / close) without spinning
// up the whole background script.

// --- Register message display script ---
browser.scripting.messageDisplay
  .registerScripts([
    {
      id: "postguard-message-display",
      css: ["/content/message-display.css"],
      js: ["/content/message-display.js"],
    },
  ])
  .catch(console.info);

// --- Register ALL event listeners BEFORE heavy awaits ---

async function resolveComposeTabIdFromWindow(
  windowId: number | undefined,
): Promise<number | undefined> {
  if (!windowId) return undefined;
  const tabs = await browser.tabs.query({
    windowId,
    type: "messageCompose",
  });
  return tabs[0]?.id;
}

browser.runtime.onMessage.addListener(
  (message: unknown, sender: browser.MessageSender) =>
    dispatchRuntimeMessage(message, sender, {
      handleQueryMessageState,
      handleToggleEncryption,
      handleGetComposeState,
      handleOpenPolicyEditor,
      handlePolicyEditorInit,
      handlePolicyEditorDone,
      handleCryptoPopupInit,
      handleCryptoPopupDone,
      handleCryptoPopupError,
      handleCryptoPopupUploadInit,
      handleDecryptMessage,
      resolveComposeTabId: resolveComposeTabIdFromWindow,
    }),
);

browser.compose.onBeforeSend.addListener(handleBeforeSend);

browser.compose.onAfterSend.addListener((tab, sendInfo) =>
  handleAfterSend(tab, sendInfo, {
    notifyError,
    isPGEncrypted,
    getOrCreateLocalFolder,
    getFullMessage: (msgId) => browser.messages.getFull(msgId),
    injectMimeHeaders,
  }),
);

// Clean up decryptedMessages when messages are deleted
browser.messages.onDeleted.addListener((deletedMessages) => {
  for (const msg of deletedMessages.messages) {
    cleanupDecryptedMessage(msg.id);
  }
});

browser.windows.onCreated.addListener(async (window) => {
  if (window.type === "messageCompose") {
    const tabs = await browser.tabs.query({ windowId: window.id });
    if (tabs.length > 0 && tabs[0].id != null) {
      const tab = tabs[0];
      const encrypt = await shouldEncrypt(tab.id);
      // Only set default state if the user hasn't already toggled encryption
      // for this tab (race: user can toggle before this async handler finishes)
      if (!composeTabs.has(tab.id)) {
        composeTabs.set(tab.id, { encrypt });
      }
      await updateComposeActionIcon(tab.id);
    }
  }
});

// --- Compose Action: toggle encryption per tab ---

async function updateComposeActionIcon(tabId: number) {
  const state = composeTabs.get(tabId);
  const enabled = state?.encrypt ?? false;
  await browser.composeAction.setIcon({
    tabId,
    path: enabled ? "icons/icon-enabled.svg" : "icons/icon-disabled.svg",
  });
  await browser.composeAction.setTitle({
    tabId,
    title: enabled
      ? browser.i18n.getMessage("encryptionEnabled")
      : browser.i18n.getMessage("encryptionDisabled"),
  });
}

// --- Deferred initialization (after all listeners are registered) ---

const { version: tbVersion } = await browser.runtime.getBrowserInfo();
const extVersion = browser.runtime.getManifest().version;

PG_CLIENT_HEADER = {
  "X-PostGuard-Client-Version": `Thunderbird,${tbVersion},pg4tb,${extVersion}`,
  // Identifies this add-in in cryptify's per-channel upload metrics
  // (encryption4all/cryptify#102). Explicit header avoids relying on
  // cryptify's Origin/User-Agent fallbacks, which are environment- and
  // host-dependent.
  "X-Cryptify-Source": "thunderbird",
};

console.log(`[PostGuard] v${extVersion} started (Thunderbird ${tbVersion})`);

// Initialize state for any existing compose tabs on startup
const existingTabs = await browser.tabs.query({ type: "messageCompose" });
for (const tab of existingTabs) {
  if (tab.id != null) {
    const encrypt = await shouldEncrypt(tab.id);
    composeTabs.set(tab.id, { encrypt });
    await updateComposeActionIcon(tab.id);
  }
}

// Restore any persisted encryption state from a previous background session.
// This runs AFTER the default initialization above so that persisted user
// toggles override the shouldEncrypt defaults.
await restoreEncryptState();
for (const tab of existingTabs) {
  if (tab.id != null) {
    await updateComposeActionIcon(tab.id);
  }
}

// Probe any in-flight Cryptify uploads that survived a background
// restart. pg-js doesn't yet expose a "continue createEnvelope from a
// rehydrated FileState" entry point, so we cannot transparently finish
// the previous upload — but we can detect a definitively-dead session
// (`UploadSessionExpiredError`) and surface it to the user instead of
// silently dropping the record on the next send attempt.
checkInFlightUploadsOnStartup().catch((e) =>
  console.warn("[PostGuard] in-flight upload probe failed:", e)
);

async function checkInFlightUploadsOnStartup() {
  if (!CRYPTIFY_URL) return;
  const records = await loadInFlightUploads();
  if (records.length === 0) return;
  let sawExpired = false;
  for (const { tabId, record } of records) {
    try {
      await resumeUpload(CRYPTIFY_URL, record.uuid, record.recoveryToken);
      // Session still alive on the server side. Keep the record so a
      // future SDK release with a continue-from-FileState entry point
      // can rehydrate it.
      inFlightUploads.set(tabId, record);
    } catch (e) {
      if (e instanceof UploadSessionExpiredError) {
        sawExpired = true;
        // The session is gone; drop the record.
      } else {
        // Transient network error — keep the record for the next probe.
        console.warn("[PostGuard] resumeUpload probe failed:", e);
        inFlightUploads.set(tabId, record);
      }
    }
  }
  await persistInFlightUploads();
  if (sawExpired) notifyError("uploadSessionExpired");
}

async function shouldEncrypt(tabId: number): Promise<boolean> {
  try {
    const details = await browser.compose.getComposeDetails(tabId);
    if (details.type === "reply" && details.relatedMessageId) {
      const encrypted = await isPGEncrypted(details.relatedMessageId);
      const wasEncrypted = !encrypted && await wasPGEncrypted(details.relatedMessageId);
      return encrypted || wasEncrypted;
    }
  } catch (e) {
    console.warn("[PostGuard] shouldEncrypt error:", e);
  }
  return false;
}

// --- Alarm keepalive for onBeforeSend ---

function keepAlive<T>(name: string, promise: Promise<T>): Promise<T> {
  const listener = (alarm: { name: string }) => {
    if (alarm.name === name) {
      console.log(`[PostGuard] Keepalive: waiting for ${name}`);
    }
  };
  browser.alarms.create(name, { periodInMinutes: 0.25 });
  browser.alarms.onAlarm.addListener(listener);

  return promise.finally(() => {
    browser.alarms.clear(name);
    browser.alarms.onAlarm.removeListener(listener);
  });
}

// --- Crypto popup: opens popup that owns encrypt/decrypt ---

async function openCryptoPopup(
  data: CryptoPopupInitData,
  composeTabId?: number,
): Promise<CryptoPopupResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CryptoPopupResult>();

  const popup = await browser.windows.create({
    url: "pages/yivi-popup/yivi-popup.html",
    type: "popup",
    height: 700,
    width: 620,
  });

  const popupId = popup.id;

  // Register IMMEDIATELY after create, before the popup script can send cryptoPopupInit
  pendingCryptoPopups.set(popupId, { data, composeTabId, resolve, reject });

  const closeListener = (closedId: number) => {
    if (closedId === popupId) {
      const pending = pendingCryptoPopups.get(popupId);
      if (pending) {
        pending.reject(new Error("Popup closed"));
        pendingCryptoPopups.delete(popupId);
      }
      browser.windows.onRemoved.removeListener(closeListener);
    }
  };
  browser.windows.onRemoved.addListener(closeListener);

  await browser.windows.update(popupId, {
    drawAttention: true,
    focused: true,
  });

  return keepAlive("crypto-popup", promise) as Promise<CryptoPopupResult>;
}

function handleCryptoPopupInit(windowId: number | undefined) {
  if (windowId == null) return null;
  const pending = pendingCryptoPopups.get(windowId);
  if (!pending) return null;
  return pending.data;
}

function handleCryptoPopupDone(
  windowId: number | undefined,
  result: CryptoPopupResult
) {
  if (windowId == null) return;
  const pending = pendingCryptoPopups.get(windowId);
  if (!pending) return;
  if (pending.composeTabId != null) {
    clearInFlightUpload(pending.composeTabId);
    persistInFlightUploads().catch(console.warn);
  }
  pending.resolve(result);
  pendingCryptoPopups.delete(windowId);
}

function handleCryptoPopupError(
  windowId: number | undefined,
  error: string
) {
  if (windowId == null) return;
  const pending = pendingCryptoPopups.get(windowId);
  if (!pending) return;
  if (pending.composeTabId != null) {
    clearInFlightUpload(pending.composeTabId);
    persistInFlightUploads().catch(console.warn);
  }
  pending.reject(new Error(error));
  pendingCryptoPopups.delete(windowId);
}

/** Popup → background hop fired from pg-js's `onUploadInit` callback,
 *  once the Cryptify session exists but before any chunk PUT. Records
 *  `{uuid, recoveryToken}` against the popup's owning compose tab so
 *  the session can be queried via `resumeUpload` after a background
 *  suspension or Thunderbird restart. */
function handleCryptoPopupUploadInit(
  windowId: number | undefined,
  uuid: string,
  recoveryToken: string,
) {
  if (windowId == null || !uuid || !recoveryToken) return;
  const pending = pendingCryptoPopups.get(windowId);
  if (!pending || pending.composeTabId == null) return;
  recordInFlightUpload(pending.composeTabId, uuid, recoveryToken);
  persistInFlightUploads().catch(console.warn);
}

// --- onBeforeSend: encryption hook ---

async function handleBeforeSend(tab: { id: number }, details: any) {
  const state = composeTabs.get(tab.id);
  const guard = evaluateBeforeSendGuards(state, details);
  // After the guard returns null the state is guaranteed encrypt:true.
  if (guard || !state) {
    if (!guard || guard.kind === "skip") return;
    if (guard.reason === "bcc") {
      notifyError("composeBccWarning");
    } else if (guard.reason === "policyEditorOpen" && state?.configWindowId) {
      await browser.windows.update(state.configWindowId, {
        drawAttention: true,
        focused: true,
      });
    }
    return { cancel: true };
  }

  return keepAlive(
    "onBeforeSend",
    runBeforeSendEncryption(state, details, tab.id, {
      listAttachments: (tabId) => browser.compose.listAttachments(tabId),
      getAttachmentFile: (attId) => browser.compose.getAttachmentFile(attId),
      getFullMessage: (msgId) => browser.messages.getFull(msgId),
      removeAttachment: (tabId, attId) =>
        browser.compose.removeAttachment(tabId, attId),
      addAttachment: (tabId, opts) => browser.compose.addAttachment(tabId, opts),
      openCryptoPopup,
      notifyError,
      buildMime,
      pkgUrl: PKG_URL!,
      cryptifyUrl: CRYPTIFY_URL,
      websiteUrl: POSTGUARD_WEBSITE_URL,
      pgClientHeader: PG_CLIENT_HEADER,
      xPostguardVersion: X_POSTGUARD_VERSION,
    }).then((outcome) => {
      if (outcome.sentMimeData) state.sentMimeData = outcome.sentMimeData;
      if (outcome.cancel) return { cancel: true };
      return { details: outcome.details };
    }),
  );
}

async function handleQueryMessageState(tabId: number | undefined) {
  if (tabId == null) return null;

  try {
    const msgList = await browser.messageDisplay.getDisplayedMessages(tabId);
    const msg = msgList?.messages?.[0];
    if (!msg) return null;

    const messageId = msg.id;
    const isEncrypted = await isPGEncrypted(messageId);
    const wasEncrypted = isEncrypted
      ? false
      : await wasPGEncrypted(messageId);
    const badges = decryptedMessages.get(messageId)?.badges;
    return { messageId, isEncrypted, wasEncrypted, badges };
  } catch (e) {
    console.error("[PostGuard] queryMessageState error:", e);
    return null;
  }
}

async function handleToggleEncryption(tabId: number | undefined) {
  if (tabId == null) return;
  const result = await toggleEncrypt(tabId);
  await updateComposeActionIcon(tabId);
  return result;
}

async function handleGetComposeState(tabId: number | undefined) {
  if (tabId == null) {
    return { encrypt: false, hasRecipients: false, recipients: [], from: "", hasBcc: false };
  }
  const state = composeTabs.get(tabId);
  const details = await browser.compose.getComposeDetails(tabId);
  // Normalize to address-only, lowercased form so the keys line up with the
  // policy/signId maps (both keyed via `toEmail`) for the status panel.
  const recipients = [...(details.to ?? []), ...(details.cc ?? [])].map(toEmail);
  const hasRecipients = recipients.length > 0;
  const hasBcc = (details.bcc ?? []).length > 0;
  return {
    encrypt: state?.encrypt ?? false,
    policy: state?.policy,
    signId: state?.signId,
    recipients,
    from: toEmail(details.from),
    hasRecipients,
    hasBcc,
  };
}

// --- Policy editor flow ---

async function handleOpenPolicyEditor(
  windowId: number | undefined,
  sign: boolean
) {
  if (windowId == null) return;

  const tabs = await browser.tabs.query({
    windowId,
    type: "messageCompose",
  });
  if (tabs.length === 0) return;

  const tabId = tabs[0].id;
  const state = composeTabs.get(tabId);
  if (!state) return;

  if (!sign && state.configWindowId) return;
  if (sign && state.signWindowId) return;

  const details = await browser.compose.getComposeDetails(tabId);
  const recipients = sign ? [details.from] : [...(details.to ?? []), ...(details.cc ?? [])];

  let initialPolicy: Policy = {};
  for (const r of recipients) {
    const email = toEmail(r);
    initialPolicy[email] = [];
  }

  const existingPolicy = sign ? state.signId : state.policy;
  if (existingPolicy) {
    for (const [rec, con] of Object.entries(existingPolicy)) {
      if (rec in initialPolicy) {
        initialPolicy[rec] = con;
      }
    }
  }

  const popup = await browser.windows.create({
    url: "pages/policy-editor/policy-editor.html",
    type: "popup",
    height: 400,
    width: 700,
  });

  const popupId = popup.id;
  if (sign) {
    state.signWindowId = popupId;
  } else {
    state.configWindowId = popupId;
  }

  const policyPromise = new Promise<Policy>((resolve, reject) => {
    pendingPolicyEditors.set(popupId, {
      composeTabId: tabId,
      initialPolicy,
      sign,
      resolve,
      reject,
    });
  });

  const closeListener = (closedWindowId: number) => {
    if (closedWindowId === popupId) {
      const pending = pendingPolicyEditors.get(popupId);
      if (pending) {
        pending.reject(new Error("window closed"));
        pendingPolicyEditors.delete(popupId);
      }
      browser.windows.onRemoved.removeListener(closeListener);
    }
  };
  browser.windows.onRemoved.addListener(closeListener);

  try {
    const newPolicy = await policyPromise;
    if (sign) {
      state.signId = newPolicy;
    } else {
      state.policy = newPolicy;
    }
  } catch {
    // user cancelled
  } finally {
    if (sign) {
      state.signWindowId = undefined;
    } else {
      state.configWindowId = undefined;
    }
    browser.windows.onRemoved.removeListener(closeListener);
  }
}

async function handlePolicyEditorInit(windowId: number | undefined) {
  if (windowId == null) return null;
  const pending = pendingPolicyEditors.get(windowId);
  if (!pending) return null;
  return {
    initialPolicy: pending.initialPolicy,
    sign: pending.sign,
  };
}

async function handlePolicyEditorDone(
  windowId: number | undefined,
  policy: Policy
) {
  if (windowId == null) return;
  const pending = pendingPolicyEditors.get(windowId);
  if (!pending) return;

  pending.resolve(policy);
  pendingPolicyEditors.delete(windowId);
}

// --- Decrypt message ---

async function handleDecryptMessage(messageId: number): Promise<{ ok: boolean; error?: string }> {
  console.log("[PostGuard] Decrypt requested for message:", messageId);

  try {
    const msg = await browser.messages.get(messageId);

    // Extract ciphertext using SDK email helpers
    const attachments = await browser.messages.listAttachments(messageId);
    const attData = await Promise.all(
      attachments.map(async (att) => {
        const file = await browser.messages.getAttachmentFile(messageId, att.partName);
        return {
          name: att.name,
          data: await file.arrayBuffer(),
        };
      })
    );

    let htmlBody: string | null = null;
    try {
      const full = await browser.messages.getFull(messageId);
      htmlBody = findHtmlBody(full);
    } catch {
      // ignore
    }

    // Tier 1/2: ciphertext lives in the postguard.encrypted attachment.
    // Tier 3: no attachment — we extract the Cryptify uuid from the body
    // and let the popup fetch+decrypt via pg.open({ uuid }).
    const rawCiphertext = extractCiphertext({
      htmlBody: htmlBody ?? undefined,
      attachments: attData,
    });
    const { ciphertext, uploadUuid } = chooseDecryptionInput(
      rawCiphertext,
      rawCiphertext ? null : extractUploadUuid(htmlBody ?? ""),
    );

    if (!ciphertext && !uploadUuid) {
      console.error("[PostGuard] No ciphertext or upload uuid found in message");
      return { ok: false, error: "decryptionError" };
    }

    // Find our email among recipients
    const recipientEmail = pickRecipientEmail(msg.recipients, msg.ccList, toEmail);

    // Delegate decryption to popup — popup creates its own pg instance,
    // renders Yivi QR, decrypts, and returns the plaintext + sender
    const result = await openCryptoPopup({
      operation: "decrypt",
      config: {
        pkgUrl: PKG_URL!,
        cryptifyUrl: CRYPTIFY_URL,
        headers: PG_CLIENT_HEADER,
      },
      ciphertextBase64: ciphertext ? toBase64(ciphertext) : undefined,
      uuid: uploadUuid ?? undefined,
      recipientEmail: recipientEmail ?? "",
    }) as DecryptPopupResult;

    const plaintext = new TextDecoder().decode(fromBase64(result.plaintextBase64));

    // Build badges from sender identity (FriendlySender format)
    const badges = badgesFromSender(result.sender);

    // Inject threading headers from the encrypted envelope
    const envelopeFull = await browser.messages.getFull(messageId);
    const { headers: threadingHeaders, remove: threadingRemove } =
      buildDecryptedThreadingHeaders(envelopeFull);

    let markedPlaintext = plaintext;
    if (Object.keys(threadingHeaders).length > 0) {
      markedPlaintext = injectMimeHeaders(markedPlaintext, threadingHeaders, threadingRemove);
    }

    // Inject X-PostGuard header
    markedPlaintext = injectMimeHeaders(markedPlaintext, { "X-PostGuard": "decrypted" });

    // Import decrypted message into the original folder
    const file = new File([markedPlaintext], "decrypted.eml", {
      type: "text/plain",
    });
    const importedMsg = await browser.messages.import(file, msg.folder.id);
    const importedMsgId = importedMsg.id;
    console.log("[PostGuard] Imported decrypted message:", importedMsgId);

    // Track badges for the decrypted message
    decryptedMessages.set(importedMsgId, { badges });

    // Delete the encrypted original
    await browser.messages.delete([messageId], true);

    // Select the decrypted message in the current mail tab
    try {
      const mailTabs = await browser.mailTabs.query({ active: true, currentWindow: true });
      if (mailTabs.length > 0) {
        await browser.mailTabs.setSelectedMessages(mailTabs[0].id, [importedMsgId]);
      }
    } catch (e) {
      console.warn("[PostGuard] Could not select decrypted message:", e);
    }

    return { ok: true };
  } catch (e) {
    console.error("[PostGuard] Decryption failed:", e);
    const errorKey = classifyDecryptionError(e);
    notifyError(errorKey);
    return { ok: false, error: errorKey };
  }
}

export { PKG_URL, keepAlive, isPGEncrypted, wasPGEncrypted };
