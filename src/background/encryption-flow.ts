/// <reference path="../types/thunderbird.d.ts" />

import type {
  Policy,
  SerializedRecipient,
  CryptoPopupInitData,
  CryptoPopupResult,
  EncryptPopupResult,
} from "../lib/types";
import { toEmail, EMAIL_ATTRIBUTE_TYPE } from "../lib/utils";
import { toBase64, fromBase64 } from "../lib/encoding";

// Pure helpers pulled out of `handleBeforeSend` so the recipient /
// threading-header logic can be exercised in isolation under vitest.
// `background.ts` calls these directly — behavior is unchanged.

export type BeforeSendGuardResult =
  | { kind: "skip" }
  | { kind: "cancel"; reason: "bcc" | "policyEditorOpen" };

/**
 * Early-exit decision for `onBeforeSend`. Pulled out so the three branches
 * (encryption disabled, BCC present, policy editor already open) can be
 * pinned without driving the full encryption pipeline.
 *
 * Returns `null` when the send should proceed to encryption.
 */
export function evaluateBeforeSendGuards(
  state: { encrypt: boolean; configWindowId?: number } | undefined,
  details: { bcc?: readonly string[] | null },
): BeforeSendGuardResult | null {
  if (!state?.encrypt) return { kind: "skip" };
  if ((details.bcc ?? []).length > 0) return { kind: "cancel", reason: "bcc" };
  if (state.configWindowId != null) {
    return { kind: "cancel", reason: "policyEditorOpen" };
  }
  return null;
}

/** Local cap above pg-js's tier-3 cutoff; some SMTP servers refuse mail
 *  over 5 MB even when Cryptify is available. */
export const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;

/**
 * Translate the compose tab's to/cc list into the wire format the popup
 * forwards to pg-js. Recipients with a custom policy in `customPolicies`
 * carry that policy through; the email attribute is normalized to
 * lowercase to match the IRMA disclosure form.
 *
 * BCC is intentionally omitted — the user-facing flow blocks send if any
 * BCC is set, so it never reaches this function.
 */
export function serializeRecipients(
  to: readonly string[],
  cc: readonly string[],
  customPolicies?: Policy,
): SerializedRecipient[] {
  return [...to, ...cc].map((addr) => {
    const id = toEmail(addr);
    if (customPolicies && customPolicies[id]) {
      return {
        type: "email" as const,
        email: id,
        policy: customPolicies[id].map(({ t, v }) =>
          t === EMAIL_ATTRIBUTE_TYPE ? { t, v: v.toLowerCase() } : { t, v },
        ),
      };
    }
    return { type: "email" as const, email: id };
  });
}

export interface ThreadingHeaders {
  inReplyTo?: string;
  references?: string;
}

/**
 * Pull `In-Reply-To` / `References` out of the related message's full
 * headers blob (the shape returned by `browser.messages.getFull`). The
 * returned References is the parent's References plus the parent's
 * Message-ID — per RFC 5322 §3.6.4.
 *
 * Returns an empty object if there is no Message-ID. The caller is
 * expected to drop the related-message read if it threw entirely; this
 * function just handles the "header is missing" case.
 */
export function buildThreadingHeaders(
  relFull: { headers: Record<string, string[] | string | undefined> } | null | undefined,
): ThreadingHeaders {
  if (!relFull) return {};
  const raw = relFull.headers["message-id"];
  const relMsgId = Array.isArray(raw) ? raw[0] : raw;
  if (!relMsgId) return {};
  const relRefsRaw = relFull.headers["references"];
  const relRefs = Array.isArray(relRefsRaw) ? relRefsRaw[0] : relRefsRaw;
  return {
    inReplyTo: relMsgId,
    references: relRefs ? `${relRefs} ${relMsgId}` : relMsgId,
  };
}

// --- Encryption pipeline (lifted from handleBeforeSend's keepAlive closure) ---

export interface AttachmentRef {
  id: number;
}

export interface AttachmentInput {
  name: string;
  type: string;
  data: ArrayBuffer;
}

export interface BeforeSendDetails {
  from: string;
  to: readonly string[];
  cc: readonly string[];
  bcc?: readonly string[];
  subject: string;
  body?: string;
  plainTextBody?: string;
  isPlainText?: boolean;
  relatedMessageId?: number;
}

export interface BeforeSendState {
  encrypt: boolean;
  policy?: Policy;
  signId?: Policy;
  sentMimeData?: Uint8Array;
}

export interface RunBeforeSendDeps {
  listAttachments: (tabId: number) => Promise<AttachmentRef[]>;
  getAttachmentFile: (attId: number) => Promise<{
    name: string;
    type: string;
    arrayBuffer: () => Promise<ArrayBuffer>;
  }>;
  getFullMessage: (messageId: number) => Promise<{
    headers: Record<string, string[] | string | undefined>;
  } | null>;
  removeAttachment: (tabId: number, attId: number) => Promise<void>;
  addAttachment: (tabId: number, opts: { file: File }) => Promise<void>;
  openCryptoPopup: (
    data: CryptoPopupInitData,
    composeTabId?: number,
  ) => Promise<CryptoPopupResult>;
  notifyError: (messageKey: string) => void;
  buildMime: (input: {
    from: string;
    to: string[];
    cc: string[];
    subject: string;
    htmlBody?: string;
    plainTextBody?: string;
    date: Date;
    inReplyTo?: string;
    references?: string;
    attachments: AttachmentInput[];
  }) => Uint8Array;
  pkgUrl: string;
  cryptifyUrl?: string;
  websiteUrl?: string;
  pgClientHeader: Record<string, string>;
  xPostguardVersion: string;
}

export interface BeforeSendOutcome {
  cancel?: boolean;
  details?: {
    subject: string;
    body: string;
    plainTextBody: string;
    customHeaders: { name: string; value: string }[];
  };
  /** Populated on success — caller assigns to state.sentMimeData so
   *  the onAfterSend handler can stash a plaintext copy in Sent. */
  sentMimeData?: Uint8Array;
}

/**
 * The encryption body that used to live inside `handleBeforeSend`'s
 * `keepAlive` closure. Lifted out so the failure / cancel / leak-guard
 * paths can be exercised without driving the full WebExtension surface.
 *
 * All Thunderbird and pg-js surfaces are injected via `deps`; the
 * function returns the value the listener should resolve with. On any
 * thrown error (including popup-closed) it notifies the user, returns
 * `{ cancel: true }`, and never returns a `details` block — so a
 * partial / failed encryption can't leak plaintext through subject or
 * body.
 */
export async function runBeforeSendEncryption(
  state: BeforeSendState,
  details: BeforeSendDetails,
  tabId: number,
  deps: RunBeforeSendDeps,
): Promise<BeforeSendOutcome> {
  try {
    const originalSubject = details.subject;
    const date = new Date();

    const composeAttachments = await deps.listAttachments(tabId);
    const attachmentData: AttachmentInput[] = await Promise.all(
      composeAttachments.map(async (att) => {
        const file = await deps.getAttachmentFile(att.id);
        return {
          name: file.name,
          type: file.type,
          data: await file.arrayBuffer(),
        };
      }),
    );

    let inReplyTo: string | undefined;
    let references: string | undefined;
    if (details.relatedMessageId) {
      try {
        const relFull = await deps.getFullMessage(details.relatedMessageId);
        ({ inReplyTo, references } = buildThreadingHeaders(relFull));
      } catch (e) {
        console.warn("[PostGuard] Could not fetch related message headers:", e);
      }
    }

    const mimeData = deps.buildMime({
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

    const serializedRecipients: SerializedRecipient[] = serializeRecipients(
      details.to,
      details.cc,
      state.policy,
    );

    const from = toEmail(details.from);
    const signIdPolicy = state.signId;
    const senderAttributes = signIdPolicy?.[from]?.filter(
      (attr) => attr.t !== EMAIL_ATTRIBUTE_TYPE,
    );

    const result = (await deps.openCryptoPopup(
      {
        operation: "encrypt",
        config: {
          pkgUrl: deps.pkgUrl,
          cryptifyUrl: deps.cryptifyUrl,
          headers: deps.pgClientHeader,
        },
        mimeDataBase64: toBase64(mimeData),
        recipients: serializedRecipients,
        senderEmail: from,
        from: details.from,
        websiteUrl: deps.websiteUrl,
        senderAttributes,
      },
      tabId,
    )) as EncryptPopupResult;

    // Detach originals only after the popup resolves. If it throws or
    // the user closes it, the compose window must still hold the
    // originals — otherwise a cancelled send silently loses the user's
    // attachments (issue #129).
    for (const att of composeAttachments) {
      await deps.removeAttachment(tabId, att.id);
    }

    if (
      result.attachmentBase64 != null &&
      result.attachmentSize <= MAX_ATTACHMENT_SIZE
    ) {
      const attBytes = fromBase64(result.attachmentBase64);
      const attFile = new File([attBytes as BlobPart], "postguard.encrypted", {
        type: "application/postguard; charset=utf-8",
      });
      await deps.addAttachment(tabId, { file: attFile });
    }

    return {
      sentMimeData: mimeData,
      details: {
        subject: result.subject,
        body: result.htmlBody,
        plainTextBody: result.plainTextBody,
        customHeaders: [
          { name: "x-postguard", value: deps.xPostguardVersion },
        ],
      },
    };
  } catch (e) {
    console.error("[PostGuard] Encryption failed:", e);
    deps.notifyError("encryptionError");
    return { cancel: true };
  }
}
