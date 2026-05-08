/// <reference path="../../types/thunderbird.d.ts" />
export {};

import { PostGuard, UploadSessionExpiredError } from "@e4a/pg-js";
import type {
  DecryptDataResult,
  DecryptFileResult,
  DecryptResult,
  Recipient,
} from "@e4a/pg-js";
import { toBase64, fromBase64 } from "../../lib/encoding";
import type {
  CryptoPopupInitData,
  EncryptPopupData,
  DecryptPopupData,
} from "../../lib/types";
import { EMAIL_ATTRIBUTE_TYPE } from "../../lib/utils";

// console.log calls are stripped in release builds by esbuild's `pure` option

const titleEl = document.getElementById("title") as HTMLElement;
const subtitleEl = document.getElementById("subtitle") as HTMLElement;
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
    titleEl.textContent = browser.i18n.getMessage("displayMessageTitleSign");
    subtitleEl.textContent = browser.i18n.getMessage("displayMessageQrPrefix");
  }

  loadingEl.hidden = true;

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
    // pg-js surfaces a dead Cryptify session as `UploadSessionExpiredError`.
    // The generic encryption-error wording is misleading here — the local
    // encryption succeeded, the server side dropped the upload. Use the
    // dedicated i18n string so the user knows to start a fresh send.
    const message = e instanceof UploadSessionExpiredError
      ? browser.i18n.getMessage("uploadSessionExpired")
      : e instanceof Error ? e.message : "Operation failed.";
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
  const recipients: Recipient[] = data.recipients.map((r) => {
    const base = r.type === "emailDomain"
      ? pg.recipient.emailDomain(r.email)
      : pg.recipient.email(r.email);
    if (r.policy) {
      for (const attr of r.policy) {
        if (attr.t !== EMAIL_ATTRIBUTE_TYPE) {
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
      attributes: data.senderAttributes,
    }),
    recipients,
    data: mimeData,
  });

  // Create encrypted email envelope. `onUploadInit` fires once, after
  // Cryptify's `upload_init` resolves and before any chunk PUT, so the
  // background can persist `{uuid, recoveryToken}` against this compose
  // tab from the moment the session exists. The callback runs inside
  // pg-js's upload-stream start handler — a throw would abort the
  // upload — so we fire-and-forget the sendMessage.
  const envelope = await pg.email.createEnvelope({
    sealed,
    from: data.from,
    websiteUrl: data.websiteUrl,
    senderAttributes: data.senderAttributes?.map((attr) => attr.v),
    onUploadInit: ({ uuid, recoveryToken }) => {
      browser.runtime
        .sendMessage({
          type: "cryptoPopupUploadInit",
          windowId,
          uuid,
          recoveryToken,
        })
        .catch((err: unknown) => {
          console.warn("[PostGuard Popup] cryptoPopupUploadInit send failed:", err);
        });
    },
  });

  // pg-js 1.1.0+: envelope.attachment is null in tier 3 (the encrypted
  // payload was too large for a local attachment; the body has the
  // Cryptify download link instead).
  let attachmentBase64: string | null = null;
  let attachmentSize = 0;
  if (envelope.attachment) {
    const attBytes = new Uint8Array(await envelope.attachment.arrayBuffer());
    attachmentBase64 = toBase64(attBytes);
    attachmentSize = attBytes.byteLength;
  }

  await browser.runtime.sendMessage({
    type: "cryptoPopupDone",
    windowId,
    result: {
      operation: "encrypt",
      subject: envelope.subject,
      htmlBody: envelope.htmlBody,
      plainTextBody: envelope.plainTextBody,
      attachmentBase64,
      attachmentSize,
      tier: envelope.tier,
      uploadUuid: envelope.uploadUuid,
    },
  });
}

async function handleDecrypt(pg: PostGuard, data: DecryptPopupData, windowId: number) {
  // Background hands us either tier-1/2 ciphertext bytes (from the
  // postguard.encrypted attachment) or a tier-3 Cryptify uuid (no
  // attachment exists; the encrypted payload is on Cryptify).
  let plaintext: Uint8Array;
  let sender: DecryptDataResult["sender"];

  if (data.uuid) {
    const opened = pg.open({ uuid: data.uuid });
    const result = await opened.decrypt({
      element: "#yivi-web-form",
      recipient: data.recipientEmail,
    });
    if (!isDecryptFileResult(result)) {
      throw new Error("Expected file decrypt result for uploaded ciphertext");
    }
    // pg-js's upload pipeline always wraps `data:`-mode payloads as a
    // single-file zip (`data.bin` = the raw MIME) before sealing, so the
    // uuid-mode decrypt yields a zip blob even though our caller used
    // `data:` on the encrypt side. Unwrap it here. Tracked upstream at
    // encryption4all/postguard-js#39 — once that lands the SDK will hand
    // back a DecryptDataResult directly and this branch can collapse.
    plaintext = await extractFromZip(result.blob, "data.bin");
    sender = result.sender;
  } else if (data.ciphertextBase64) {
    const ciphertext = fromBase64(data.ciphertextBase64);
    const opened = pg.open({ data: ciphertext });
    const result = await opened.decrypt({
      element: "#yivi-web-form",
      recipient: data.recipientEmail,
    });
    if (!isDecryptDataResult(result)) {
      throw new Error("Expected data decrypt result for attached ciphertext");
    }
    plaintext = result.plaintext;
    sender = result.sender;
  } else {
    throw new Error("Decrypt popup requires either ciphertextBase64 or uuid");
  }

  await browser.runtime.sendMessage({
    type: "cryptoPopupDone",
    windowId,
    result: {
      operation: "decrypt",
      plaintextBase64: toBase64(plaintext),
      sender,
    },
  });
}

function isDecryptFileResult(result: DecryptResult): result is DecryptFileResult {
  return "blob" in result;
}

function isDecryptDataResult(result: DecryptResult): result is DecryptDataResult {
  return "plaintext" in result;
}

/** Extract a single file from a ZIP blob and return its uncompressed
 *  bytes. Reads via the central directory because conflux (pg-js's zip
 *  writer) emits streaming-mode local file headers with `compressedSize:
 *  0`. Supports stored (method 0) and deflate (method 8); the latter via
 *  DecompressionStream('deflate-raw'), the right decoder for ZIP-embedded
 *  deflate. */
async function extractFromZip(blob: Blob, filename: string): Promise<Uint8Array> {
  const buf = await blob.arrayBuffer();
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const decoder = new TextDecoder("utf-8");

  // Locate the End-of-Central-Directory record (signature 0x06054b50);
  // it sits in the last 22 + comment(<=64KB) bytes.
  let eocdOffset = -1;
  for (
    let i = bytes.length - 22;
    i >= Math.max(0, bytes.length - 65557);
    i--
  ) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("ZIP EOCD record not found");

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const numEntries = view.getUint16(eocdOffset + 10, true);

  let pos = cdOffset;
  for (let i = 0; i < numEntries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break; // CDR signature

    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const lfhOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(
      bytes.slice(pos + 46, pos + 46 + nameLen)
    );

    if (name === filename) {
      const lfhNameLen = view.getUint16(lfhOffset + 26, true);
      const lfhExtraLen = view.getUint16(lfhOffset + 28, true);
      const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);

      if (method === 0) return compressed;
      if (method === 8) {
        const stream = new Blob([compressed as BlobPart])
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      throw new Error(`Unsupported zip compression method ${method} for ${filename}`);
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }

  throw new Error(`File "${filename}" not found in zip`);
}

function showError(msg: string) {
  loadingEl.hidden = true;
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

init();
