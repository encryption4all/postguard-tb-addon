/// <reference path="../types/thunderbird.d.ts" />

import { PostGuard } from "@e4a/pg-js";
import type { DecryptDataResult } from "@e4a/pg-js";
import { composeTabs, decryptedMessages } from "./state";
import type { ComposeTabState } from "./state";
import { PKG_URL, CRYPTIFY_URL, POSTGUARD_WEBSITE_URL } from "../lib/pkg-client";
import { toEmail, EMAIL_ATTRIBUTE_TYPE, typeToImage, findHtmlBody } from "../lib/utils";
import { getOrCreateLocalFolder } from "../lib/folders";
import type { Policy, AttributeCon, KeySort, PopupData } from "../lib/types";

const POSTGUARD_SUBJECT = "PostGuard Encrypted Email";

function notifyError(messageKey: string) {
  browser.notifications.create({
    type: "basic",
    title: "PostGuard",
    message: browser.i18n.getMessage(messageKey),
  });
}

const { version: tbVersion } = await browser.runtime.getBrowserInfo();
const extVersion = browser.runtime.getManifest().version;

export const PG_CLIENT_HEADER = {
  "X-PostGuard-Client-Version": `Thunderbird,${tbVersion},pg4tb,${extVersion}`,
};

console.log(`[PostGuard] v${extVersion} started (Thunderbird ${tbVersion})`);

// --- Module-level state ---
let pg: PostGuard | null = null;

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

// --- Initialize PostGuard SDK ---
// The SDK dynamically imports @e4a/pg-wasm, which the build remaps to ./pg-wasm/load.js.
pg = new PostGuard({
  pkgUrl: PKG_URL!,
  cryptifyUrl: CRYPTIFY_URL,
  headers: PG_CLIENT_HEADER,
});

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

browser.runtime.onMessage.addListener(
  (message: unknown, sender: browser.MessageSender) => {
    if (!message || typeof message !== "object") return false;
    const msg = message as Record<string, unknown>;

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
        const localFolder = await getOrCreateLocalFolder("PostGuard Sent");
        if (localFolder) {
          const file = new File([state.sentMimeData as BlobPart], "sent.eml", {
            type: "text/plain",
          });
          const localMsg = await (browser.messages as any).import(
            file,
            localFolder.id
          );
          await browser.messages.move([localMsg.id], msg.folder.id as any);
          await (browser.messages as any).delete([msg.id], true);
        }
      }
    }
  } catch (e) {
    console.error("[PostGuard] Failed to manage sent copy:", e);
  } finally {
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

async function isPGEncrypted(msgId: number): Promise<boolean> {
  const attachments = await browser.messages.listAttachments(msgId);
  if (attachments.some((att) => att.name === "postguard.encrypted")) return true;

  try {
    const full = await browser.messages.getFull(msgId);
    const bodyHtml = findHtmlBody(full);
    if (bodyHtml && bodyHtml.includes("-----BEGIN POSTGUARD MESSAGE-----")) return true;
  } catch {
    // ignore
  }

  return false;
}

// --- Alarm keepalive for onBeforeSend ---

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

  if (details.bcc.length > 0) {
    console.warn("[PostGuard] BCC not supported with encryption");
    return { cancel: true };
  }

  if (state.configWindowId) {
    await browser.windows.update(state.configWindowId, {
      drawAttention: true,
      focused: true,
    });
    return { cancel: true };
  }

  if (!pg) {
    console.error("[PostGuard] SDK not initialized, cannot encrypt");
    notifyError("encryptionError");
    return { cancel: true };
  }

  const { promise, resolve } = Promise.withResolvers<
    { cancel?: boolean; details?: Partial<typeof details> } | void
  >();

  keepAlive("onBeforeSend", (async () => {
    try {
      const originalSubject = details.subject;
      const date = new Date();

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

      // Fetch threading headers if replying
      let inReplyTo: string | undefined;
      let references: string | undefined;
      if (details.relatedMessageId) {
        try {
          const relFull = await browser.messages.getFull(details.relatedMessageId);
          const relMsgId = relFull.headers["message-id"]?.[0];
          if (relMsgId) {
            inReplyTo = relMsgId;
            const relRefs = relFull.headers["references"]?.[0];
            references = relRefs ? `${relRefs} ${relMsgId}` : relMsgId;
          }
        } catch (e) {
          console.warn("[PostGuard] Could not fetch related message headers:", e);
        }
      }

      // Build inner MIME using SDK
      const mimeData = pg!.email.buildMime({
        from: details.from,
        to: [...details.to],
        cc: [...details.cc],
        subject: originalSubject,
        htmlBody: details.isPlainText ? undefined : details.body,
        plainTextBody: details.isPlainText ? details.plainTextBody : undefined,
        date,
        inReplyTo,
        references,
        attachments: attachmentData,
      });

      // Build recipients with custom policies if set
      const customPolicies = state.policy;
      const recipients = [...details.to, ...details.cc];
      const pgRecipients = recipients.map((r: string) => {
        const id = toEmail(r);
        if (customPolicies && customPolicies[id]) {
          return pg!.recipient.withPolicy(
            id,
            customPolicies[id].map(({ t, v }) =>
              t === EMAIL_ATTRIBUTE_TYPE ? { t, v: v.toLowerCase() } : { t, v }
            )
          );
        }
        return pg!.recipient.email(id);
      });

      // Build sign identity
      const from = toEmail(details.from);
      const signCon: AttributeCon = [{ t: EMAIL_ATTRIBUTE_TYPE, v: from }];
      const privSignId = state.signId?.[from]?.filter(
        ({ t }) => t !== EMAIL_ATTRIBUTE_TYPE
      );
      if (privSignId) {
        signCon.push(...privSignId);
      }

      // Build sealed encryption builder (lazy — encrypts when createEnvelope calls toBytes)
      const sealed = pg!.encrypt({
        sign: pg!.sign.session(
          async ({ con, sort }) => createYiviPopup(con as AttributeCon, sort as KeySort),
          { senderEmail: from }
        ),
        recipients: pgRecipients,
        data: mimeData,
      });

      // Remove original attachments
      for (const att of composeAttachments) {
        await browser.compose.removeAttachment(tab.id, att.id);
      }

      // Create encrypted email envelope using SDK (encrypts + builds placeholder HTML).
      // For large payloads, createEnvelope auto-uploads to Cryptify and puts a
      // download link in the HTML body.
      const envelope = await pg!.email.createEnvelope({
        sealed,
        from: details.from,
        websiteUrl: POSTGUARD_WEBSITE_URL,
      });

      // Only attach the encrypted file if it's under 5 MB.
      // Larger payloads are already uploaded to Cryptify with a download link in the HTML.
      const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;
      if (envelope.attachment.size <= MAX_ATTACHMENT_SIZE) {
        await browser.compose.addAttachment(tab.id, { file: envelope.attachment });
      }

      // Store MIME data for sent copy
      state.sentMimeData = mimeData;

      // Replace body and subject
      resolve({
        details: {
          subject: envelope.subject,
          body: envelope.htmlBody,
          plainTextBody: envelope.plainTextBody,
        },
      });
    } catch (e) {
      console.error("[PostGuard] Encryption failed:", e);
      notifyError("encryptionError");
      resolve({ cancel: true });
    }
  })());

  return promise;
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

  const details = await browser.compose.getComposeDetails(tabId);
  await browser.compose.setComposeDetails(tabId, {
    deliveryFormat: state.encrypt ? "both" : "auto",
  } as Partial<typeof details>);

  const hasRecipients = [...(details.to ?? []), ...(details.cc ?? [])].length > 0;
  return { encrypt: state.encrypt, hasRecipients };
}

async function handleGetComposeState(tabId: number | undefined) {
  if (tabId == null) return { encrypt: false, hasRecipients: false };
  const state = composeTabs.get(tabId);
  const details = await browser.compose.getComposeDetails(tabId);
  const hasRecipients = [...(details.to ?? []), ...(details.cc ?? [])].length > 0;
  return { encrypt: state?.encrypt ?? false, policy: state?.policy, hasRecipients };
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
  await browser.windows.get(windowId).then(() =>
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
    hostname: PKG_URL!,
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

async function handleDecryptMessage(messageId: number): Promise<{ ok: boolean; error?: string }> {
  console.log("[PostGuard] Decrypt requested for message:", messageId);

  if (!pg) {
    console.error("[PostGuard] SDK not initialized");
    notifyError("startupError");
    return { ok: false, error: "startupError" };
  }

  try {
    const msg = await browser.messages.get(messageId);

    // Extract ciphertext using SDK
    const attachments = await browser.messages.listAttachments(messageId);
    const attData = await Promise.all(
      attachments.map(async (att) => {
        const file = await browser.messages.getAttachmentFile(messageId, att.partName);
        return {
          name: att.name,
          data: await (file as any).arrayBuffer(),
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

    const ciphertext = pg.email.extractCiphertext({
      htmlBody: htmlBody ?? undefined,
      attachments: attData,
    });

    if (!ciphertext) {
      console.error("[PostGuard] No ciphertext found in message");
      return { ok: false, error: "decryptionError" };
    }

    // Find our email among recipients
    const myAddresses = [...msg.recipients, ...msg.ccList].map(toEmail);

    // Decrypt using SDK: open sealed data, then decrypt with session callback
    const opened = pg.open({ data: ciphertext });
    const result = await opened.decrypt({
      recipient: myAddresses[0],
      session: async ({ con, sort, hints, senderId }) => {
        return createYiviPopup(
          con as AttributeCon,
          sort as KeySort,
          hints as AttributeCon | undefined,
          senderId
        );
      },
    }) as DecryptDataResult;

    const plaintext = new TextDecoder().decode(result.plaintext);

    // Build badges from sender identity (FriendlySender format)
    const sender = result.sender;
    const badges = (sender?.attributes ?? []).map(
      ({ type: t, value: v }) => ({
        type: typeToImage(t),
        value: v ?? "",
      })
    );

    // Inject threading headers from the encrypted envelope
    const envelopeFull = await browser.messages.getFull(messageId);
    const threadingHeaders: Record<string, string> = {};
    const threadingRemove: string[] = [];
    for (const name of ["in-reply-to", "references"] as const) {
      const val = envelopeFull.headers[name]?.[0];
      if (val) {
        const headerName = name === "in-reply-to" ? "In-Reply-To" : "References";
        threadingHeaders[headerName] = val;
        threadingRemove.push(headerName);
      }
    }

    let markedPlaintext = plaintext;
    if (Object.keys(threadingHeaders).length > 0) {
      markedPlaintext = pg.email.injectMimeHeaders(markedPlaintext, threadingHeaders, threadingRemove);
    }

    // Inject X-PostGuard header
    markedPlaintext = pg.email.injectMimeHeaders(markedPlaintext, { "X-PostGuard": "decrypted" });

    // Import decrypted message into the original folder
    const file = new File([markedPlaintext], "decrypted.eml", {
      type: "text/plain",
    });
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

    return { ok: true };
  } catch (e) {
    console.error("[PostGuard] Decryption failed:", e);
    const errorKey = e instanceof Error && e.message.includes("KEM error")
      ? "decryptionFailed"
      : "decryptionError";
    notifyError(errorKey);
    return { ok: false, error: errorKey };
  }
}

export { PKG_URL, POSTGUARD_SUBJECT, keepAlive, isPGEncrypted, wasPGEncrypted };
