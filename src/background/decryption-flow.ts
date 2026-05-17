/// <reference path="../types/thunderbird.d.ts" />

import type { Badge } from "../lib/types";

// Pure helpers pulled out of `handleDecryptMessage` so the
// ciphertext-extraction / threading-header / error-classification logic
// can be exercised in isolation under vitest.

export interface DecryptionInputs {
  ciphertext: Uint8Array | null;
  uploadUuid: string | null;
}

/**
 * Decide where the ciphertext should be sourced from for this message.
 * Tier 1/2 envelopes ship a `postguard.encrypted` attachment that the
 * caller has already passed through pg-js's `extractCiphertext`. Tier 3
 * envelopes have no attachment and the caller has run `extractUploadUuid`
 * over the HTML body. This function just picks which one to use.
 *
 * Returns both as `null` when neither input is present — the listener
 * surfaces that as `decryptionError`.
 */
export function chooseDecryptionInput(
  ciphertext: Uint8Array | null | undefined,
  uploadUuid: string | null | undefined,
): DecryptionInputs {
  if (ciphertext) return { ciphertext, uploadUuid: null };
  if (uploadUuid) return { ciphertext: null, uploadUuid };
  return { ciphertext: null, uploadUuid: null };
}

/**
 * Pick the address we should ask the popup to decrypt for. The
 * production code uses the first recipient/cc address as a heuristic;
 * it is also lowercased to match the IRMA email-attribute form.
 */
export function pickRecipientEmail(
  recipients: readonly string[],
  ccList: readonly string[],
  toEmail: (addr: string) => string,
): string | undefined {
  const first = [...recipients, ...ccList][0];
  return first === undefined ? undefined : toEmail(first).toLowerCase();
}

export interface DecryptedThreadingHeaders {
  headers: Record<string, string>;
  remove: string[];
}

/**
 * Pull `Message-ID`, `In-Reply-To`, and `References` from the encrypted
 * envelope's headers and shape them for `injectMimeHeaders`: the `headers`
 * map goes onto the plaintext, and the `remove` list drops any pre-existing
 * occurrence so we don't end up with two copies.
 *
 * `Message-ID` is part of this set because `buildMime` (the inner-plaintext
 * builder in pg-js) does not emit one. Without it, replies to the
 * decrypted message can't reference this thread by ID, which silently
 * breaks threading from this point onward.
 */
export function buildDecryptedThreadingHeaders(
  envelopeFull: { headers: Record<string, string[] | string | undefined> },
): DecryptedThreadingHeaders {
  const headers: Record<string, string> = {};
  const remove: string[] = [];
  const map = {
    "message-id": "Message-ID",
    "in-reply-to": "In-Reply-To",
    references: "References",
  } as const;
  for (const lower of Object.keys(map) as Array<keyof typeof map>) {
    const raw = envelopeFull.headers[lower];
    const val = Array.isArray(raw) ? raw[0] : raw;
    if (val) {
      headers[map[lower]] = val;
      remove.push(map[lower]);
    }
  }
  return { headers, remove };
}

/**
 * Map a thrown decryption error to the i18n key the listener notifies on
 * and returns to the content script. pg-js surfaces a wrong-attribute
 * decryption as a "KEM error" message; the user-facing copy distinguishes
 * "you don't have the right key" (decryptionFailed) from generic failures
 * (decryptionError).
 */
export function classifyDecryptionError(
  e: unknown,
): "decryptionFailed" | "decryptionError" {
  if (e instanceof Error && e.message.includes("KEM error")) {
    return "decryptionFailed";
  }
  return "decryptionError";
}

/**
 * Build the badge array stored in `decryptedMessages` for the decrypted
 * message banner. Each badge is the disclosed attribute value (or empty
 * string for an undisclosed attribute).
 */
export function badgesFromSender(
  sender:
    | {
        attributes?: ReadonlyArray<{ value?: string | null }>;
      }
    | null
    | undefined,
): Badge[] {
  return (sender?.attributes ?? []).map((a) => ({ value: a.value ?? "" }));
}
