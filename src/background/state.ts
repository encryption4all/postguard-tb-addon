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
  /** Compose tab that owns the popup, when the operation is `encrypt`.
   *  Used to associate `cryptoPopupUploadInit` callbacks with the
   *  right tab's in-flight-upload record. Absent on decrypt popups. */
  composeTabId?: number;
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

// --- In-flight Cryptify upload tracking ---
// Captured from pg-js's `onUploadInit` callback on the popup side and
// persisted here so a background suspension / Thunderbird restart can
// still query the upload session via `resumeUpload(uuid, recoveryToken)`.
// Records are cleared on successful send (or popup error) and pruned on
// startup against `MAX_IN_FLIGHT_AGE_MS`.

export interface InFlightUpload {
  uuid: string;
  recoveryToken: string;
  /** Millisecond timestamp captured at `onUploadInit`. Used to drop
   *  records older than the Cryptify session TTL on restart. */
  startedAt: number;
}

export const inFlightUploads = new Map<number, InFlightUpload>();

const IN_FLIGHT_KEY = "inFlightUploads";

/** Drop records older than this on restart instead of querying Cryptify.
 *  Cryptify's default session TTL is hours; 24h is a generous upper
 *  bound that avoids hammering the server with confirmed-dead sessions. */
export const MAX_IN_FLIGHT_AGE_MS = 24 * 60 * 60 * 1000;

export async function persistInFlightUploads(): Promise<void> {
  if (inFlightUploads.size === 0) {
    await browser.storage.local.remove(IN_FLIGHT_KEY);
    return;
  }
  const out: Record<string, InFlightUpload> = {};
  for (const [tabId, record] of inFlightUploads) {
    out[String(tabId)] = record;
  }
  await browser.storage.local.set({ [IN_FLIGHT_KEY]: out });
}

/** Read persisted records and return the ones still within the
 *  freshness window. Stale records are dropped without a network call.
 *  Callers are expected to feed the returned list into `resumeUpload` to
 *  classify each as alive / expired and react accordingly. */
export async function loadInFlightUploads(): Promise<Array<{ tabId: number; record: InFlightUpload }>> {
  try {
    const data = await browser.storage.local.get(IN_FLIGHT_KEY);
    const saved = data[IN_FLIGHT_KEY] as Record<string, InFlightUpload> | undefined;
    if (!saved) return [];
    const now = Date.now();
    const fresh: Array<{ tabId: number; record: InFlightUpload }> = [];
    for (const [tabIdStr, record] of Object.entries(saved)) {
      if (now - record.startedAt <= MAX_IN_FLIGHT_AGE_MS) {
        fresh.push({ tabId: Number(tabIdStr), record });
      }
    }
    return fresh;
  } catch (e) {
    console.warn("[PostGuard] Failed to load in-flight uploads:", e);
    return [];
  }
}

export function recordInFlightUpload(tabId: number, uuid: string, recoveryToken: string): void {
  inFlightUploads.set(tabId, { uuid, recoveryToken, startedAt: Date.now() });
}

export function clearInFlightUpload(tabId: number): void {
  inFlightUploads.delete(tabId);
}
