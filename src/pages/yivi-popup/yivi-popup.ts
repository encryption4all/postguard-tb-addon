/// <reference path="../../types/thunderbird.d.ts" />
export {};

import { PostGuard } from "@e4a/pg-js";
import type { DecryptDataResult } from "@e4a/pg-js";
import { toBase64, fromBase64 } from "../../lib/encoding";
import type {
  CryptoPopupInitData,
  EncryptPopupData,
  DecryptPopupData,
} from "../../lib/types";

// console.log calls are stripped in release builds by esbuild's `pure` option

const titleEl = document.getElementById("title") as HTMLElement;
const subtitleEl = document.getElementById("subtitle") as HTMLElement;
const senderEl = document.getElementById("sender-info") as HTMLElement;
const errorEl = document.getElementById("error") as HTMLElement;
const loadingEl = document.getElementById("loading") as HTMLElement;

async function init() {
  console.log("[PostGuard Popup]","init() called");

  // Get our own window ID — used in all messages so background can look up our pending entry
  let windowId: number;
  try {
    const win = await browser.windows.getCurrent();
    windowId = win.id;
    console.log("[PostGuard Popup]","windowId:", windowId);
  } catch (e) {
    console.log("[PostGuard Popup]","windows.getCurrent() failed:", e);
    showError("Failed to get window ID.");
    return;
  }

  let data: CryptoPopupInitData | null;
  try {
    data = (await browser.runtime.sendMessage({
      type: "cryptoPopupInit",
      windowId,
    })) as CryptoPopupInitData | null;
    console.log("[PostGuard Popup]","cryptoPopupInit response:", data ? data.operation : data);
  } catch (e) {
    console.log("[PostGuard Popup]","sendMessage(cryptoPopupInit) threw:", e);
    showError("Failed to initialize session.");
    return;
  }

  if (!data) {
    console.log("[PostGuard Popup]","data is null/undefined — no pending entry found in background for windowId:", windowId);
    showError("Failed to initialize session.");
    return;
  }

  // Update UI based on operation
  if (data.operation === "decrypt") {
    titleEl.textContent = browser.i18n.getMessage("displayMessageTitle");
    subtitleEl.textContent = browser.i18n.getMessage("displayMessageHeading");
  } else {
    titleEl.textContent = "PostGuard — Sign";
    subtitleEl.textContent = browser.i18n.getMessage("displayMessageQrPrefix");
  }

  loadingEl.style.display = "none";

  // Create PostGuard instance for this popup
  const pg = new PostGuard(data.config);

  try {
    if (data.operation === "encrypt") {
      await handleEncrypt(pg, data, windowId);
    } else {
      await handleDecrypt(pg, data, windowId);
    }

    // Auto-close after a short delay
    setTimeout(() => browser.windows.remove(windowId), 750);
  } catch (e) {
    console.error("[PostGuard] Crypto popup error:", e);
    const message = e instanceof Error ? e.message : "Operation failed.";
    await browser.runtime.sendMessage({
      type: "cryptoPopupError",
      windowId,
      error: message,
    });
    showError(message);
  }
}

async function handleEncrypt(pg: PostGuard, data: EncryptPopupData, windowId: number) {
  const mimeData = fromBase64(data.mimeDataBase64);

  // Rebuild typed recipients from serialized data
  const recipients = data.recipients.map((r) => {
    const base = r.type === "emailDomain"
      ? pg.recipient.emailDomain(r.email)
      : pg.recipient.email(r.email);
    if (r.policy) {
      for (const attr of r.policy) {
        if (attr.t !== "pbdf.sidn-pbdf.email.email") {
          base.extraAttribute(attr.t, attr.v);
        }
      }
    }
    return base;
  });

  // Encrypt with element-based Yivi signing
  const sealed = pg.encrypt({
    sign: pg.sign.yivi({
      element: "#yivi-web-form",
      senderEmail: data.senderEmail,
    }),
    recipients,
    data: mimeData,
  });

  // Create encrypted email envelope
  const envelope = await pg.email.createEnvelope({
    sealed,
    from: data.from,
    websiteUrl: data.websiteUrl,
  });

  // Read the attachment File into base64
  const attBytes = new Uint8Array(await envelope.attachment.arrayBuffer());

  await browser.runtime.sendMessage({
    type: "cryptoPopupDone",
    windowId,
    result: {
      operation: "encrypt",
      subject: envelope.subject,
      htmlBody: envelope.htmlBody,
      plainTextBody: envelope.plainTextBody,
      attachmentBase64: toBase64(attBytes),
      attachmentSize: attBytes.byteLength,
    },
  });
}

async function handleDecrypt(pg: PostGuard, data: DecryptPopupData, windowId: number) {
  const ciphertext = fromBase64(data.ciphertextBase64);

  // Decrypt with element-based Yivi
  const opened = pg.open({ data: ciphertext });
  const result = (await opened.decrypt({
    element: "#yivi-web-form",
    recipient: data.recipientEmail,
  })) as DecryptDataResult;

  await browser.runtime.sendMessage({
    type: "cryptoPopupDone",
    windowId,
    result: {
      operation: "decrypt",
      plaintextBase64: toBase64(result.plaintext),
      sender: result.sender,
    },
  });
}

function showError(msg: string) {
  loadingEl.style.display = "none";
  errorEl.textContent = msg;
  errorEl.style.display = "block";
}

init();
