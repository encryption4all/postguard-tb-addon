import type { Policy, AttributeCon, Badge } from "../lib/types";

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
