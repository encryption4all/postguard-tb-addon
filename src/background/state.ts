import type { Policy, AttributeCon, Badge, CryptoPopupInitData, CryptoPopupResult } from "../lib/types";
import { EMAIL_ATTRIBUTE_TYPE } from "../lib/utils";
import { encryptString, decryptString, type EncryptedBlob } from "./token-crypto";

export type { Policy, AttributeCon };

export interface ComposeTabState {
  encrypt: boolean;
  policy?: Policy;
  signId?: Policy;
  configWindowId?: number;
  signWindowId?: number;
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

    // Rewrite (don't wipe) so state survives the next suspension too.
    await persistEncryptState();
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
//
// The `recoveryToken` is a session credential and must never touch disk in
// cleartext. The in-memory `InFlightUpload` holds the
// plaintext token (needed to call `resumeUpload`), but the *persisted* form
// (`PersistedInFlightUpload`) stores it AES-GCM-encrypted via `token-crypto`.

export interface InFlightUpload {
  uuid: string;
  recoveryToken: string;
  /** Millisecond timestamp captured at `onUploadInit`. Used to drop
   *  records older than the Cryptify session TTL on restart. */
  startedAt: number;
}

/** On-disk shape written to `storage.local`: the credential is encrypted,
 *  while `uuid`/`startedAt` stay in the clear so stale records can be pruned
 *  without a decrypt (and `uuid` alone is useless without the token). */
interface PersistedInFlightUpload {
  uuid: string;
  /** Encrypted `recoveryToken`. Optional so records written by pre-fix
   *  versions (plaintext `recoveryToken`) can still be read once on upgrade. */
  token?: EncryptedBlob;
  /** @deprecated Legacy plaintext token from builds before the credential was
   *  encrypted at rest. Read once on upgrade, then re-persisted encrypted;
   *  never written. */
  recoveryToken?: string;
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
  const out: Record<string, PersistedInFlightUpload> = {};
  for (const [tabId, record] of inFlightUploads) {
    out[String(tabId)] = {
      uuid: record.uuid,
      token: await encryptString(record.recoveryToken),
      startedAt: record.startedAt,
    };
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
    const saved = data[IN_FLIGHT_KEY] as Record<string, PersistedInFlightUpload> | undefined;
    if (!saved) return [];
    const now = Date.now();
    const fresh: Array<{ tabId: number; record: InFlightUpload }> = [];
    for (const [tabIdStr, persisted] of Object.entries(saved)) {
      // Prune stale records before spending any crypto work on them.
      if (now - persisted.startedAt > MAX_IN_FLIGHT_AGE_MS) continue;
      const recoveryToken = await recoverToken(persisted);
      if (recoveryToken == null) continue; // undecryptable / malformed — drop it
      fresh.push({
        tabId: Number(tabIdStr),
        record: { uuid: persisted.uuid, recoveryToken, startedAt: persisted.startedAt },
      });
    }
    return fresh;
  } catch (e) {
    console.warn("[PostGuard] Failed to load in-flight uploads:", e);
    return [];
  }
}

/** Recover the plaintext token from a persisted record: decrypt the encrypted
 *  envelope, or accept a legacy plaintext token written by a pre-fix build.
 *  Returns null if the token can't be recovered so the caller drops the
 *  (short-lived, ≤24h) record rather than crashing the startup probe. */
async function recoverToken(persisted: PersistedInFlightUpload): Promise<string | null> {
  if (persisted.token) {
    try {
      return await decryptString(persisted.token);
    } catch (e) {
      console.warn("[PostGuard] Failed to decrypt in-flight upload token; dropping record:", e);
      return null;
    }
  }
  // Legacy plaintext record from before the credential was encrypted at rest:
  // read it once so an active session survives the upgrade; the next persist
  // re-writes it encrypted.
  return typeof persisted.recoveryToken === "string" ? persisted.recoveryToken : null;
}

export function recordInFlightUpload(tabId: number, uuid: string, recoveryToken: string): void {
  inFlightUploads.set(tabId, { uuid, recoveryToken, startedAt: Date.now() });
}

export function clearInFlightUpload(tabId: number): void {
  inFlightUploads.delete(tabId);
}

// --- Per-account sign-attribute prefills (issue #77) ---
// The attributes a user discloses when signing rarely change between emails,
// yet the old flow asked for them on every compose. We persist the last-saved
// sign attributes keyed by the sender's account so the next compose for that
// account pre-fills them; the user can still edit them in the policy editor.
//
// The account key is the sender's from-address (lowercased). Each Thunderbird
// identity has its own from-address, so this keeps different accounts'
// attributes separate — exactly the per-account scoping the issue asks for.

const SIGN_PREFILLS_KEY = "signPrefills";

// account email -> the attributes saved for that account
type SignPrefills = Record<string, AttributeCon>;

function accountKey(account: string): string {
  return account.trim().toLowerCase();
}

/** Read the saved sign attributes for an account, or [] if none are stored. */
export async function getSignPrefill(account: string): Promise<AttributeCon> {
  try {
    const data = await browser.storage.local.get(SIGN_PREFILLS_KEY);
    const saved = data[SIGN_PREFILLS_KEY] as SignPrefills | undefined;
    return saved?.[accountKey(account)] ?? [];
  } catch (e) {
    console.warn("[PostGuard] Failed to read sign prefills:", e);
    return [];
  }
}

/**
 * Persist the sign attributes the user just saved for an account so the next
 * compose pre-fills them. The locked email attribute (always the sender's own
 * address) and any blank-valued attributes are dropped — a blank value must
 * not become a mandatory empty-string disclosure next time. Saving an empty
 * set clears any previously stored prefill for the account.
 */
export async function setSignPrefill(account: string, attrs: AttributeCon): Promise<void> {
  try {
    const key = accountKey(account);
    const cleaned = attrs.filter(
      (a) => a.t !== EMAIL_ATTRIBUTE_TYPE && a.v.trim() !== "",
    );
    const data = await browser.storage.local.get(SIGN_PREFILLS_KEY);
    const saved = (data[SIGN_PREFILLS_KEY] as SignPrefills | undefined) ?? {};
    if (cleaned.length === 0) {
      delete saved[key];
    } else {
      saved[key] = cleaned;
    }
    await browser.storage.local.set({ [SIGN_PREFILLS_KEY]: saved });
  } catch (e) {
    console.warn("[PostGuard] Failed to persist sign prefills:", e);
  }
}
