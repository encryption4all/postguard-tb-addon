import type { Policy, AttributeCon, Badge, CryptoPopupInitData, CryptoPopupResult } from "../lib/types";

export type { Policy, AttributeCon };

export interface ComposeTabState {
  encrypt: boolean;
  policy?: Policy;
  signId?: Policy;
  configWindowId?: number;
  signWindowId?: number;
  newMsgId?: number;
  sentMimeData?: Uint8Array;
}

// Per-compose-tab state
export const composeTabs = new Map<number, ComposeTabState>();

// Tracks badges for decrypted messages
export const decryptedMessages = new Map<number, { badges?: Badge[] }>();

// --- Pending popup tracking maps ---
// Keyed by popup windowId. Entries added when a popup is opened, removed on
// resolve / reject / window-close. Tests pin "no stale entries" invariants
// so future refactors can't reintroduce leaks.

export interface PendingPolicyEditor {
  composeTabId: number;
  initialPolicy: Policy;
  sign: boolean;
  resolve: (policy: Policy) => void;
  reject: (err: Error) => void;
}

export interface PendingCryptoPopup {
  data: CryptoPopupInitData;
  resolve: (result: CryptoPopupResult) => void;
  reject: (err: Error) => void;
}

export const pendingPolicyEditors = new Map<number, PendingPolicyEditor>();
export const pendingCryptoPopups = new Map<number, PendingCryptoPopup>();

// --- Encryption state persistence ---
// Persist the encryption toggle state so it survives background suspension/restart.
// Only the `encrypt` flag and `policy` are persisted (not transient fields like
// configWindowId or sentMimeData).

const STORAGE_KEY = "composeTabEncryptState";

interface PersistedTabState {
  encrypt: boolean;
  policy?: Policy;
}

export async function persistEncryptState(): Promise<void> {
  const state: Record<string, PersistedTabState> = {};
  for (const [tabId, tab] of composeTabs) {
    if (tab.encrypt) {
      state[String(tabId)] = { encrypt: tab.encrypt, policy: tab.policy };
    }
  }
  await browser.storage.local.set({ [STORAGE_KEY]: state });
}

export async function restoreEncryptState(): Promise<void> {
  try {
    const data = await browser.storage.local.get(STORAGE_KEY);
    const saved = data[STORAGE_KEY] as Record<string, PersistedTabState> | undefined;
    if (!saved) return;

    // Verify the tabs still exist before restoring
    const existingTabs = await browser.tabs.query({ type: "messageCompose" });
    const existingTabIds = new Set(existingTabs.map((t) => t.id));

    for (const [tabIdStr, persisted] of Object.entries(saved)) {
      const tabId = Number(tabIdStr);
      if (existingTabIds.has(tabId) && persisted.encrypt) {
        const existing = composeTabs.get(tabId);
        if (existing) {
          // Don't downgrade: if already set to encrypt, keep it
          if (!existing.encrypt) {
            existing.encrypt = persisted.encrypt;
            if (persisted.policy) existing.policy = persisted.policy;
          }
        } else {
          composeTabs.set(tabId, { encrypt: persisted.encrypt, policy: persisted.policy });
        }
      }
    }

    // Clean up stale entries
    await browser.storage.local.remove(STORAGE_KEY);
  } catch (e) {
    console.warn("[PostGuard] Failed to restore encrypt state:", e);
  }
}

// --- Lifecycle helpers ---
// Extracted from `background.ts` so they can be exercised under vitest
// without spinning up the whole background script. Behavior unchanged —
// `background.ts` now calls these helpers from its event listeners.

/**
 * Toggle the encryption flag for a compose tab. Updates the persisted state
 * and the compose deliveryFormat. Returns the new flag plus whether the tab
 * has any To/Cc recipients (the popup uses this to surface a warning).
 *
 * Icon updates are the caller's responsibility because they touch
 * compose-action UI rather than state.
 */
export async function toggleEncrypt(
  tabId: number,
): Promise<{ encrypt: boolean; hasRecipients: boolean }> {
  const state = composeTabs.get(tabId) ?? { encrypt: false };
  state.encrypt = !state.encrypt;
  composeTabs.set(tabId, state);

  // Fire-and-forget; honor the local toggle even if persistence fails.
  persistEncryptState().catch((e) => console.warn("[PostGuard] persist failed", e));

  const details = await browser.compose.getComposeDetails(tabId);
  await browser.compose.setComposeDetails(tabId, {
    deliveryFormat: state.encrypt ? "both" : "auto",
  } as Partial<typeof details>);

  const hasRecipients = [...(details.to ?? []), ...(details.cc ?? [])].length > 0;
  return { encrypt: state.encrypt, hasRecipients };
}

/** Drop all state associated with a compose tab (called on send / close). */
export function cleanupComposeTab(tabId: number): void {
  composeTabs.delete(tabId);
}

/** Drop the decrypted-message entry for a deleted message id. No-op if absent. */
export function cleanupDecryptedMessage(msgId: number): void {
  decryptedMessages.delete(msgId);
}
