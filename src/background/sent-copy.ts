/// <reference path="../types/thunderbird.d.ts" />

import {
  composeTabs,
  cleanupComposeTab,
  clearInFlightUpload,
  persistEncryptState,
  persistInFlightUploads,
} from "./state";

// Pulled out of background.ts so the post-send cleanup can be exercised
// under vitest without standing up the whole background script. Deps that
// hit Thunderbird APIs we cannot easily mock from the browser-mock helper
// are injected, and the rest goes through the browser-mock surface.

export interface SentMessage {
  id: number;
  folder: { id: unknown };
}

export interface SentInfo {
  messages: SentMessage[];
}

export interface SentCopyDeps {
  notifyError: (messageKey: string) => void;
  isPGEncrypted: (msgId: number) => Promise<boolean>;
  getOrCreateLocalFolder: (
    name: string,
  ) => Promise<{ id: unknown } | undefined>;
}

/**
 * Post-send handler. For each message the user just sent, if it is a
 * PostGuard ciphertext, swap the encrypted copy in Sent with the plaintext
 * MIME stashed during encryption. State cleanup happens in `finally` so a
 * failure mid-swap never strands the compose tab in `composeTabs`.
 */
export async function handleAfterSend(
  tab: { id: number },
  sendInfo: SentInfo,
  deps: SentCopyDeps,
): Promise<void> {
  const state = composeTabs.get(tab.id);
  if (!state?.sentMimeData) return;

  try {
    for (const msg of sendInfo.messages) {
      if (!(await deps.isPGEncrypted(msg.id))) continue;
      const localFolder = await deps.getOrCreateLocalFolder("PostGuard Sent");
      if (!localFolder) continue;
      const file = new File([state.sentMimeData as BlobPart], "sent.eml", {
        type: "text/plain",
      });
      const localMsg = await browser.messages.import(
        file,
        localFolder.id as any,
      );
      await browser.messages.move([localMsg.id], msg.folder.id as any);
      await browser.messages.delete([msg.id], true);
    }
  } catch (e) {
    console.error("[PostGuard] Failed to manage sent copy:", e);
    deps.notifyError("sentCopyError");
  } finally {
    cleanupComposeTab(tab.id);
    clearInFlightUpload(tab.id);
    persistEncryptState().catch(console.warn);
    persistInFlightUploads().catch(console.warn);
  }
}
