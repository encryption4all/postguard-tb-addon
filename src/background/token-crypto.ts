// AES-GCM encryption-at-rest for short-lived upload-session credentials.
//
// Short-lived upload credentials should not be persisted to disk in the clear,
// so the credential is wrapped with an AES-GCM key before it is stored.
//
// The token is wrapped with an AES-GCM key that is:
//   * generated once per installation,
//   * marked NON-EXTRACTABLE, so JavaScript can never export the raw key
//     bytes, and
//   * kept in IndexedDB — a different storage backend than the credential
//     store itself.
//
// This is a proportionate mitigation for a local-access, short-lived (≤24h)
// credential; it is not a claim of protection against an attacker who can
// already read and fully reverse-engineer the profile, since Thunderbird
// exposes no OS keystore to extensions.

/** Ciphertext envelope stored in place of the plaintext token. */
export interface EncryptedBlob {
  /** AES-GCM IV (12 random bytes), base64-encoded. */
  iv: string;
  /** Ciphertext + auth tag, base64-encoded. */
  data: string;
}

const DB_NAME = "postguard-keystore";
const STORE_NAME = "keys";
const KEY_ID = "in-flight-token-key";

// Memoised so we don't reopen IndexedDB on every persist/load. Reset to
// undefined if key acquisition fails so a later call can retry.
let cachedKey: Promise<CryptoKey> | undefined;
// Ephemeral fallback used only when no IndexedDB backend exists (e.g. under
// vitest in Node). Encryption still round-trips within a single session.
let memoryKey: CryptoKey | undefined;

function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadOrCreateKey(): Promise<CryptoKey> {
  // No persistent keystore (non-browser env / tests): fall back to an
  // in-memory key so encryption still works, without touching disk.
  if (typeof indexedDB === "undefined") {
    if (!memoryKey) memoryKey = await generateKey();
    return memoryKey;
  }
  const db = await openDb();
  try {
    const existing = (await idbGet(db, KEY_ID)) as CryptoKey | undefined;
    // A stored CryptoKey survives structured-clone round-trips; guard against
    // anything else that might have been left in the store.
    if (existing instanceof CryptoKey) return existing;
    const key = await generateKey();
    await idbPut(db, KEY_ID, key);
    return key;
  } finally {
    db.close();
  }
}

function getKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    cachedKey = loadOrCreateKey().catch((e) => {
      cachedKey = undefined; // allow a later retry
      throw e;
    });
  }
  return cachedKey;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encrypt a token into a storable envelope. */
export async function encryptString(plaintext: string): Promise<EncryptedBlob> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(ct)) };
}

/** Decrypt an envelope produced by {@link encryptString}. Throws if the blob
 *  was written under a different key (e.g. the keystore was cleared) or is
 *  malformed — callers treat that as a dropped record. */
export async function decryptString(blob: EncryptedBlob): Promise<string> {
  const key = await getKey();
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(blob.iv) },
    key,
    fromBase64(blob.data),
  );
  return new TextDecoder().decode(pt);
}
