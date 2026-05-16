import type { PostGuard } from "@e4a/pg-js";
import type { EncryptPopupData } from "../../lib/types";
import { toBase64, fromBase64 } from "../../lib/encoding";
import { buildRecipients } from "./recipients";

export interface EncryptPopupDeps {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
}

/** The Yivi element selector pg-js renders the QR scanner into. */
export const YIVI_ELEMENT_SELECTOR = "#yivi-web-form";

/**
 * Body of the popup's encrypt flow, lifted out of `handleEncrypt` so the
 * SDK wiring (decode → recipients → encrypt → envelope → result) can be
 * exercised under vitest with a fake `pg` and a stubbed `runtime`. The
 * production caller passes the live `browser.runtime`.
 */
export async function runEncryptInPopup(
  pg: PostGuard,
  data: EncryptPopupData,
  windowId: number,
  deps: EncryptPopupDeps,
): Promise<void> {
  const mimeData = fromBase64(data.mimeDataBase64);
  const recipients = buildRecipients(pg.recipient, data.recipients);

  const sealed = pg.encrypt({
    sign: pg.sign.yivi({
      element: YIVI_ELEMENT_SELECTOR,
      senderEmail: data.senderEmail,
      attributes: data.senderAttributes,
    }),
    recipients,
    data: mimeData,
  });

  // `onUploadInit` fires inside pg-js's upload-stream start handler — a
  // throw would abort the upload. Fire-and-forget the sendMessage.
  const envelope = await pg.email.createEnvelope({
    sealed,
    from: data.from,
    websiteUrl: data.websiteUrl,
    senderAttributes: data.senderAttributes?.map((attr) => attr.v),
    onUploadInit: ({ uuid, recoveryToken }) => {
      deps.runtime
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

  // tier 3: envelope.attachment is null when the payload was too large
  // for a local attachment; the body's Cryptify link carries it.
  let attachmentBase64: string | null = null;
  let attachmentSize = 0;
  if (envelope.attachment) {
    const attBytes = new Uint8Array(await envelope.attachment.arrayBuffer());
    attachmentBase64 = toBase64(attBytes);
    attachmentSize = attBytes.byteLength;
  }

  await deps.runtime.sendMessage({
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
