/// <reference path="../types/thunderbird.d.ts" />

import type { Policy, SerializedRecipient } from "../lib/types";
import { toEmail, EMAIL_ATTRIBUTE_TYPE } from "../lib/utils";

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
