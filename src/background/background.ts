/// <reference path="../types/thunderbird.d.ts" />

import { composeTabs, decryptedMessages } from "./state";
import type { ComposeTabState } from "./state";
import {
  fetchPublicKey,
  fetchVerificationKey,
  setClientHeader,
  PKG_URL,
} from "../lib/pkg-client";
import { toEmail, EMAIL_ATTRIBUTE_TYPE } from "../lib/utils";
import { getSigningKeys } from "../lib/pkg-client";
import { buildInnerMime } from "../lib/mime-builder";
import { getPlaceholderHtml, getPlaceholderText } from "../lib/placeholder";
import { sealData, setSealStream } from "../lib/encryption";
import { setStreamUnsealer } from "../lib/decryption";
import { getUSK } from "../lib/pkg-client";
import { typeToImage } from "../lib/utils";
import { getOrCreateLocalFolder } from "../lib/folders";
import {
  checkLocalJwt as checkLocalJwtFromStore,
  storeLocalJwt as storeLocalJwtFromStore,
  cleanUpJwts,
} from "../lib/jwt-store";
import type { Policy, AttributeCon, KeySort, PopupData } from "../lib/types";

const POSTGUARD_SUBJECT = "PostGuard Encrypted Email";

const { version: tbVersion } = await browser.runtime.getBrowserInfo();
const extVersion = browser.runtime.getManifest().version;

export const PG_CLIENT_HEADER = {
  "X-PostGuard-Client-Version": `Thunderbird,${tbVersion},pg4tb,${extVersion}`,
};

console.log(`[PostGuard] v${extVersion} started (Thunderbird ${tbVersion})`);

setClientHeader(PG_CLIENT_HEADER);

// --- Module-level state (declared before listeners to avoid TDZ) ---
let pgWasm: any = null;
let pk: string | null = null;
let vk: string | null = null;

// Pending popup tracking maps
const pendingPolicyEditors = new Map<
  number,
  {
    composeTabId: number;
    initialPolicy: Policy;
    sign: boolean;
    resolve: (policy: Policy) => void;
    reject: (err: Error) => void;
  }
>();

const pendingYiviPopups = new Map<
  number,
  {
    data: PopupData;
    resolve: (jwt: string) => void;
    reject: (err: Error) => void;
  }
>();

const checkLocalJwt = checkLocalJwtFromStore;
const storeLocalJwt = storeLocalJwtFromStore;

// --- Load pg-wasm and fetch PKG keys on startup ---
console.log("[PostGuard] Loading pg-wasm and fetching PKG keys...");

// Use indirect dynamic import to prevent esbuild from resolving it
const pgWasmPath = "./pg-wasm/load.js";
const modPromise = import(/* @vite-ignore */ pgWasmPath).then((mod: any) => {
  setSealStream(mod.sealStream as Parameters<typeof setSealStream>[0]);
  setStreamUnsealer(mod.StreamUnsealer);
  console.log("[PostGuard] pg-wasm loaded");
  return mod;
}).catch((e: Error) => {
  console.error("[PostGuard] Failed to load pg-wasm:", e);
  return null;
});

const pkPromise = fetchPublicKey();
const vkPromise = fetchVerificationKey();

// --- Register message display script ---
// A restarting background will try to re-register — catch the error.
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
// This ensures popups/content scripts can communicate with the background
// even while pg-wasm and PKG keys are still loading.

browser.runtime.onMessage.addListener(
  (message: unknown, sender: browser.MessageSender) => {
    if (!message || typeof message !== "object") return false;
    const msg = message as Record<string, unknown>;

    // For compose-action popups, sender.tab is the popup tab itself,
    // not the compose tab. We need to find the actual compose tab
    // by querying for compose tabs in the sender's window.
    const resolveComposeTabId = async (): Promise<number | undefined> => {
      if (!sender.tab?.windowId) return undefined;
      const tabs = await browser.tabs.query({
        windowId: sender.tab.windowId,
        type: "messageCompose",
      });
      return tabs[0]?.id;
    };

    switch (msg.type) {
      case "queryMessageState":
        console.log("[PostGuard] queryMessageState sender:", JSON.stringify({
          tabId: sender.tab?.id,
          tabType: sender.tab?.type,
          windowId: sender.tab?.windowId,
          url: sender.url,
        }));
        return handleQueryMessageState(sender.tab?.id);
      case "toggleEncryption":
        return resolveComposeTabId().then((id) => handleToggleEncryption(id));
      case "getComposeState":
        return resolveComposeTabId().then((id) => handleGetComposeState(id));
      case "openPolicyEditor":
        return handleOpenPolicyEditor(sender.tab?.windowId, false);
      case "openSignEditor":
        return handleOpenPolicyEditor(sender.tab?.windowId, true);
      case "policyEditorInit":
        return handlePolicyEditorInit(sender.tab?.windowId);
      case "policyEditorDone":
        return handlePolicyEditorDone(
          sender.tab?.windowId,
          msg.policy as Policy
        );
      case "yiviPopupInit":
        return handleYiviPopupInit(sender.tab?.windowId);
      case "yiviPopupDone":
        return handleYiviPopupDone(
          sender.tab?.windowId,
          msg.jwt as string
        );
      case "decryptMessage":
        return handleDecryptMessage(msg.messageId as number);
      default:
        return false;
    }
  }
);

browser.compose.onBeforeSend.addListener(handleBeforeSend);

browser.compose.onAfterSend.addListener(async (tab, sendInfo) => {
  const state = composeTabs.get(tab.id);
  if (!state?.sentMimeData) return;

  try {
    for (const msg of sendInfo.messages) {
      if (await isPGEncrypted(msg.id)) {
        // Import plaintext copy to local sent folder
        const localFolder = await getOrCreateLocalFolder("PostGuard Sent");
        if (localFolder) {
          const file = new File([state.sentMimeData as BlobPart], "sent.eml", {
            type: "text/plain",
          });
          const localMsg = await (browser.messages as any).import(
            file,
            localFolder.id
          );

          // Move to the same folder as the sent ciphertext
          await browser.messages.move([localMsg.id], msg.folder);

          // Delete the ciphertext from sent
          await (browser.messages as any).delete([msg.id], true);
        }
      }
    }
  } catch (e) {
    console.error("[PostGuard] Failed to manage sent copy:", e);
  } finally {
    // Clean up compose tab state
    composeTabs.delete(tab.id);
  }
});

browser.windows.onCreated.addListener(async (window) => {
  if (window.type === "messageCompose") {
    const tabs = await browser.tabs.query({ windowId: window.id });
    if (tabs.length > 0 && tabs[0].id != null) {
      const tab = tabs[0];
      const encrypt = await shouldEncrypt(tab.id);
      composeTabs.set(tab.id, { encrypt });
      await updateComposeActionIcon(tab.id);
    }
  }
});

browser.alarms.create("jwt-cleanup", { periodInMinutes: 10 });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "jwt-cleanup") {
    cleanUpJwts().catch(console.error);
  }
});

// --- Now await the heavy async loading ---

const [_pgWasm, _pk, _vk] = await Promise.all([
  modPromise,
  pkPromise.catch((e: Error) => { console.error("[PostGuard] PK fetch failed:", e); return null; }),
  vkPromise.catch((e: Error) => { console.error("[PostGuard] VK fetch failed:", e); return null; }),
]);
pgWasm = _pgWasm;
pk = _pk as string | null;
vk = _vk as string | null;

if (pk) console.log("[PostGuard] Master public key loaded");
if (vk) console.log("[PostGuard] Verification key loaded");

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

// Initialize state for any existing compose tabs on startup
const existingTabs = await browser.tabs.query({ type: "messageCompose" });
for (const tab of existingTabs) {
  if (tab.id != null) {
    const encrypt = await shouldEncrypt(tab.id);
    composeTabs.set(tab.id, { encrypt });
    await updateComposeActionIcon(tab.id);
  }
}

async function shouldEncrypt(tabId: number): Promise<boolean> {
  try {
    const details = await browser.compose.getComposeDetails(tabId);
    console.log("[PostGuard] shouldEncrypt check:", {
      tabId,
      type: details.type,
      relatedMessageId: details.relatedMessageId,
      subject: details.subject,
    });
    if (details.type === "reply" && details.relatedMessageId) {
      const encrypted = await isPGEncrypted(details.relatedMessageId);
      const wasEncrypted = !encrypted && await wasPGEncrypted(details.relatedMessageId);
      console.log("[PostGuard] Reply to message:", {
        relatedMessageId: details.relatedMessageId,
        isPGEncrypted: encrypted,
        wasPGEncrypted: wasEncrypted,
      });
      return encrypted || wasEncrypted;
    }
  } catch (e) {
    console.warn("[PostGuard] shouldEncrypt error:", e);
  }
  return false;
}

async function isPGEncrypted(msgId: number): Promise<boolean> {
  const attachments = await browser.messages.listAttachments(msgId);
  return attachments.some((att) => att.name === "postguard.encrypted");
}

// --- Alarm keepalive for onBeforeSend (MV3 anti-termination pattern) ---

function keepAlive(name: string, promise: Promise<unknown>) {
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

// --- onBeforeSend: encryption hook ---

async function handleBeforeSend(tab: { id: number }, details: any) {
  const state = composeTabs.get(tab.id);
  if (!state?.encrypt) return;

  // BCC check
  if (details.bcc.length > 0) {
    console.warn("[PostGuard] BCC not supported with encryption");
    return { cancel: true };
  }

  // If policy editor is open, bring it to focus
  if (state.configWindowId) {
    await browser.windows.update(state.configWindowId, {
      drawAttention: true,
      focused: true,
    });
    return { cancel: true };
  }

  if (!pk) {
    console.error("[PostGuard] No public key available, cannot encrypt");
    return { cancel: true };
  }

  const { promise, resolve } = Promise.withResolvers<
    { cancel?: boolean; details?: Partial<typeof details> } | void
  >();

  keepAlive("onBeforeSend", (async () => {
    try {
      const originalSubject = details.subject;
      const date = new Date();
      const timestamp = Math.round(date.getTime() / 1000);

      // Build attachments list
      const composeAttachments = await browser.compose.listAttachments(tab.id);
      const attachmentData = await Promise.all(
        composeAttachments.map(async (att) => {
          const file = await browser.compose.getAttachmentFile(att.id) as unknown as File;
          return {
            name: file.name,
            type: file.type,
            data: await file.arrayBuffer(),
          };
        })
      );

      // Build inner MIME
      const mimeData = buildInnerMime({
        from: details.from,
        to: [...details.to],
        cc: [...details.cc],
        subject: originalSubject,
        body: details.body,
        plainTextBody: details.plainTextBody,
        isPlainText: details.isPlainText,
        date,
        attachments: attachmentData,
      });

      // Build per-recipient policy
      const customPolicies = state.policy;
      const recipients = [...details.to, ...details.cc];
      const sealPolicy: Record<string, { ts: number; con: Array<{ t: string; v: string }> }> = {};

      for (const recipient of recipients) {
        const id = toEmail(recipient);
        if (customPolicies && customPolicies[id]) {
          sealPolicy[id] = {
            ts: timestamp,
            con: customPolicies[id].map(({ t, v }) =>
              t === EMAIL_ATTRIBUTE_TYPE ? { t, v: v.toLowerCase() } : { t, v }
            ),
          };
        } else {
          sealPolicy[id] = {
            ts: timestamp,
            con: [{ t: EMAIL_ATTRIBUTE_TYPE, v: id }],
          };
        }
      }

      // Get signing identity
      const from = toEmail(details.from);
      const pubSignId = [{ t: EMAIL_ATTRIBUTE_TYPE, v: from }];
      const privSignId = state.signId?.[from]?.filter(
        ({ t }) => t !== EMAIL_ATTRIBUTE_TYPE
      );
      const totalId = [...pubSignId, ...(privSignId ?? [])];

      // Get JWT for signing (from cache or Yivi popup)
      const jwt = await checkLocalJwt(totalId).catch(() =>
        createYiviPopup(totalId, "Signing")
      );
      const { pubSignKey, privSignKey } = await getSigningKeys(jwt, {
        pubSignId,
        privSignId,
      });

      // Seal the message
      const sealOptions: Parameters<typeof sealData>[1] = {
        policy: sealPolicy,
        pubSignKey,
      };
      if (privSignKey) sealOptions.privSignKey = privSignKey;
      const encrypted = await sealData(pk, sealOptions, mimeData);

      // Remove original attachments
      for (const att of composeAttachments) {
        await browser.compose.removeAttachment(tab.id, att.id);
      }

      // Add encrypted attachment
      const encryptedFile = new File([encrypted as BlobPart], "postguard.encrypted", {
        type: "application/postguard; charset=utf-8",
      });
      await browser.compose.addAttachment(tab.id, { file: encryptedFile });

      // Store JWT for later use
      await storeLocalJwt(totalId, jwt);

      // Store MIME data for sent copy
      state.sentMimeData = mimeData;

      // Replace body and subject
      resolve({
        details: {
          subject: POSTGUARD_SUBJECT,
          body: getPlaceholderHtml(details.from),
          plainTextBody: getPlaceholderText(details.from),
        },
      });
    } catch (e) {
      console.error("[PostGuard] Encryption failed:", e);
      resolve({ cancel: true });
    }
  })());

  return promise;
}

async function handleQueryMessageState(tabId: number | undefined) {
  console.log("[PostGuard] queryMessageState called, tabId:", tabId);
  if (tabId == null) return null;

  try {
    const msgList = await browser.messageDisplay.getDisplayedMessages(tabId);
    const msg = msgList?.messages?.[0];
    console.log("[PostGuard] Displayed message:", msg?.id, msg?.subject);
    if (!msg) return null;

    const messageId = msg.id;
    const isEncrypted = await isPGEncrypted(messageId);
    const wasEncrypted = isEncrypted
      ? false
      : await wasPGEncrypted(messageId);
    const badges = decryptedMessages.get(messageId)?.badges;
    console.log("[PostGuard] State result:", { messageId, isEncrypted, wasEncrypted });
    return { messageId, isEncrypted, wasEncrypted, badges };
  } catch (e) {
    console.error("[PostGuard] queryMessageState error:", e);
    return null;
  }
}

async function wasPGEncrypted(msgId: number): Promise<boolean> {
  const full = await browser.messages.getFull(msgId);
  return "x-postguard" in full.headers;
}

async function handleToggleEncryption(tabId: number | undefined) {
  if (tabId == null) return;
  const state = composeTabs.get(tabId) ?? { encrypt: false };
  state.encrypt = !state.encrypt;
  composeTabs.set(tabId, state);
  await updateComposeActionIcon(tabId);

  // Set delivery format to "both" when encryption is on
  const details = await browser.compose.getComposeDetails(tabId);
  await browser.compose.setComposeDetails(tabId, {
    deliveryFormat: state.encrypt ? "both" : "auto",
  } as Partial<typeof details>);

  return { encrypt: state.encrypt };
}

async function handleGetComposeState(tabId: number | undefined) {
  if (tabId == null) return { encrypt: false };
  const state = composeTabs.get(tabId);
  return { encrypt: state?.encrypt ?? false, policy: state?.policy };
}

// --- Policy editor flow ---

async function handleOpenPolicyEditor(
  windowId: number | undefined,
  sign: boolean
) {
  if (windowId == null) return;

  // Find the compose tab in this window
  const tabs = await browser.tabs.query({
    windowId,
    type: "messageCompose",
  });
  if (tabs.length === 0) return;

  const tabId = tabs[0].id;
  const state = composeTabs.get(tabId);
  if (!state) return;

  // Check if already open
  if (!sign && state.configWindowId) return;
  if (sign && state.signWindowId) return;

  // Build initial policy from current recipients
  const details = await browser.compose.getComposeDetails(tabId);
  const recipients = sign ? [details.from] : [...details.to, ...details.cc];

  let initialPolicy: Policy = {};
  for (const r of recipients) {
    const email = toEmail(r);
    initialPolicy[email] = [];
  }

  // Merge existing policy
  const existingPolicy = sign ? state.signId : state.policy;
  if (existingPolicy) {
    for (const [rec, con] of Object.entries(existingPolicy)) {
      if (rec in initialPolicy) {
        initialPolicy[rec] = con;
      }
    }
  }

  // Open policy editor popup
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

  // Store pending editor data
  const policyPromise = new Promise<Policy>((resolve, reject) => {
    pendingPolicyEditors.set(popupId, {
      composeTabId: tabId,
      initialPolicy,
      sign,
      resolve,
      reject,
    });
  });

  // Listen for window close
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
  await browser.windows.get(windowId).then(() =>
    // Close the popup after saving
    // Use a small delay to let the message response complete
    setTimeout(() => {
      try {
        // Window might already be closed
      } catch {}
    }, 100)
  ).catch(() => {});
}

// --- Yivi popup flow ---

export async function createYiviPopup(
  con: AttributeCon,
  sort: KeySort,
  hints?: AttributeCon,
  senderId?: string
): Promise<string> {
  const popup = await browser.windows.create({
    url: "pages/yivi-popup/yivi-popup.html",
    type: "popup",
    height: 700,
    width: 620,
  });

  const popupId = popup.id;
  await browser.windows.update(popupId, {
    drawAttention: true,
    focused: true,
  });

  const data: PopupData = {
    hostname: PKG_URL,
    header: PG_CLIENT_HEADER,
    con,
    sort,
    hints,
    senderId,
  };

  const jwtPromise = new Promise<string>((resolve, reject) => {
    pendingYiviPopups.set(popupId, { data, resolve, reject });
  });

  const closeListener = (closedId: number) => {
    if (closedId === popupId) {
      const pending = pendingYiviPopups.get(popupId);
      if (pending) {
        pending.reject(new Error("Yivi popup closed"));
        pendingYiviPopups.delete(popupId);
      }
      browser.windows.onRemoved.removeListener(closeListener);
    }
  };
  browser.windows.onRemoved.addListener(closeListener);

  return keepAlive(
    "yivi-session",
    jwtPromise.finally(() => {
      browser.windows.onRemoved.removeListener(closeListener);
    })
  ) as Promise<string>;
}

async function handleYiviPopupInit(windowId: number | undefined) {
  if (windowId == null) return null;
  const pending = pendingYiviPopups.get(windowId);
  if (!pending) return null;
  return pending.data;
}

async function handleYiviPopupDone(
  windowId: number | undefined,
  jwt: string
) {
  if (windowId == null) return;
  const pending = pendingYiviPopups.get(windowId);
  if (!pending) return;

  pending.resolve(jwt);
  pendingYiviPopups.delete(windowId);
}

// --- Decrypt message ---

async function handleDecryptMessage(messageId: number) {
  console.log("[PostGuard] Decrypt requested for message:", messageId);

  if (!vk || !pgWasm) {
    console.error("[PostGuard] pg-wasm or verification key not loaded");
    return;
  }

  try {
    const msg = await browser.messages.get(messageId);
    const attachments = await browser.messages.listAttachments(messageId);
    const pgAtt = attachments.find((att) => att.name === "postguard.encrypted");
    if (!pgAtt) return;

    // Get the encrypted attachment
    const attFile = await browser.messages.getAttachmentFile(
      messageId,
      pgAtt.partName
    );

    // Create unsealer and inspect header
    const readable = (attFile as any).stream();
    const unsealer = await pgWasm.StreamUnsealer.new(readable, vk);
    const recipients = unsealer.inspect_header();

    // Find our identity among the header's recipients.
    // Check message to/cc addresses against the header's recipient list.
    const recipientKeys = recipients instanceof Map
      ? [...recipients.keys()]
      : Object.keys(recipients);
    const myAddresses = [...msg.recipients, ...msg.ccList].map(toEmail);
    const recipientId = myAddresses.find((addr) => recipientKeys.includes(addr));

    if (!recipientId) {
      console.error("[PostGuard] No matching recipient found. Header:", recipientKeys, "My addresses:", myAddresses);
      return;
    }

    const me = recipients instanceof Map
      ? recipients.get(recipientId)
      : recipients[recipientId];
    console.log("[PostGuard] Matched recipient:", recipientId);

    // Prepare hints (what attributes are needed)
    const hints = me.con.map(({ t, v }: { t: string; v: string }) =>
      t === EMAIL_ATTRIBUTE_TYPE ? { t, v: recipientId } : { t, v }
    );

    // Prepare key request (for hidden policy)
    const keyRequest = {
      ...me,
      con: me.con.map(({ t, v }: { t: string; v: string }) => {
        if (t === EMAIL_ATTRIBUTE_TYPE) return { t, v: recipientId };
        if (v === "" || v.includes("*")) return { t };
        return { t, v };
      }),
    };

    console.log("[PostGuard] Decrypting with policy:", keyRequest);

    // Get JWT from cache or Yivi popup
    const jwt = await checkLocalJwt(hints).catch(() =>
      createYiviPopup(
        keyRequest.con,
        "Decryption",
        hints,
        toEmail(msg.author)
      )
    );

    // Get USK from PKG
    const usk = await getUSK(jwt, keyRequest.ts);

    // Unseal the message
    // Need to re-create unsealer since the stream was consumed for header inspection
    const attFile2 = await browser.messages.getAttachmentFile(
      messageId,
      pgAtt.partName
    );
    const readable2 = (attFile2 as any).stream();
    const unsealer2 = await pgWasm.StreamUnsealer.new(readable2, vk);

    let plaintext = "";
    const decoder = new TextDecoder();
    const writable = new WritableStream({
      write(chunk: Uint8Array) {
        plaintext += decoder.decode(chunk, { stream: true });
      },
      close() {
        plaintext += decoder.decode();
      },
    });

    const tStart = performance.now();
    const senderIdentity = await unsealer2.unseal(recipientId, usk, writable);
    console.log(
      `[PostGuard] Decryption took ${(performance.now() - tStart).toFixed(0)}ms`
    );
    console.log("[PostGuard] Sender verification:", senderIdentity);

    // Store JWT on success
    await storeLocalJwt(hints, jwt);

    // Build badges from sender identity
    const privBadges = senderIdentity?.private?.con ?? [];
    const badges = [...senderIdentity.public.con, ...privBadges].map(
      ({ t, v }: { t: string; v: string }) => ({
        type: typeToImage(t),
        value: v,
      })
    );

    // Inject X-PostGuard header so wasPGEncrypted() recognizes decrypted messages
    const headerEnd = plaintext.indexOf("\r\n\r\n");
    const markedPlaintext = headerEnd >= 0
      ? plaintext.slice(0, headerEnd) + "\r\nX-PostGuard: decrypted" + plaintext.slice(headerEnd)
      : "X-PostGuard: decrypted\r\n" + plaintext;

    // Import decrypted message directly into the original folder
    const file = new File([markedPlaintext], "decrypted.eml", {
      type: "text/plain",
    });
    console.log("[PostGuard] Importing to folder:", msg.folder.id);
    const importedMsg = await (browser.messages as any).import(file, msg.folder.id);
    const importedMsgId = importedMsg.id;
    console.log("[PostGuard] Imported decrypted message:", importedMsgId);

    // Track badges for the decrypted message
    decryptedMessages.set(importedMsgId, { badges });

    // Delete the encrypted original
    await (browser.messages as any).delete([messageId], true);

    // Select the decrypted message in the current mail tab
    try {
      const mailTabs = await browser.mailTabs.query({ active: true, currentWindow: true });
      if (mailTabs.length > 0) {
        await browser.mailTabs.setSelectedMessages(mailTabs[0].id, [importedMsgId]);
      }
    } catch (e) {
      console.warn("[PostGuard] Could not select decrypted message:", e);
    }
  } catch (e) {
    console.error("[PostGuard] Decryption failed:", e);
    if (e instanceof Error && e.name === "OperationError") {
      console.error("[PostGuard] Wrong attributes for decryption");
    }
  }
}

export { PKG_URL, POSTGUARD_SUBJECT, keepAlive, isPGEncrypted, wasPGEncrypted };
