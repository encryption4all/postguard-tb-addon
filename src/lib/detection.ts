/// <reference path="../types/thunderbird.d.ts" />

import { extractUploadUuid } from "@e4a/pg-js";
import { findHtmlBody } from "./utils";

/**
 * Detect whether a message looks like a current PostGuard ciphertext that
 * the user can still decrypt.
 *
 * Tier 1/2 envelopes ship a `postguard.encrypted` attachment. Tier 3 has no
 * attachment — the encrypted payload lives in Cryptify, with a
 * `/decrypt?uuid=…` link in the body. Both shapes are handled by the popup's
 * decrypt path; this function only answers "looks like PostGuard" so the
 * banner can offer the Decrypt button instead of falling back to the
 * wasEncrypted info banner.
 */
export async function isPGEncrypted(msgId: number): Promise<boolean> {
  const attachments = await browser.messages.listAttachments(msgId);
  if (attachments.some((att) => att.name === "postguard.encrypted")) return true;

  try {
    const full = await browser.messages.getFull(msgId);
    const bodyHtml = findHtmlBody(full);
    if (bodyHtml && extractUploadUuid(bodyHtml)) return true;
  } catch {
    // Malformed messages / API errors mean "not detectable as encrypted",
    // not "throw". The caller falls back to the wasEncrypted check.
  }

  return false;
}

/**
 * Detect whether a message *was* a PostGuard ciphertext at some point,
 * based on the `x-postguard` header that the addon writes on outgoing mail.
 *
 * Used after decryption to label messages whose ciphertext has been
 * unwrapped but whose plaintext should still show a "was encrypted" badge.
 */
export async function wasPGEncrypted(msgId: number): Promise<boolean> {
  const full = await browser.messages.getFull(msgId);
  return "x-postguard" in full.headers;
}
