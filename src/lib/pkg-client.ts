// PKG API wrapper with browser.storage.local caching for the public key.
// The SDK handles all other PKG communication (getUSK, getSigningKeys, etc.)
// internally via the session callback pattern.

import { fetchMPK, fetchVerificationKey as fetchVK } from "@e4a/pg-js";

const PKG_URL = process.env.PKG_URL;
const PK_STORAGE_KEY = "pg-pk";

let clientHeader: Record<string, string> = {};

export function setClientHeader(header: Record<string, string>) {
  clientHeader = header;
}

export function getClientHeader(): Record<string, string> {
  return clientHeader;
}

// Fetch master public key with browser.storage.local fallback
export async function fetchPublicKey(): Promise<string> {
  const stored = await browser.storage.local.get(PK_STORAGE_KEY);
  const storedKey = stored[PK_STORAGE_KEY] as string | undefined;

  try {
    const pk = (await fetchMPK(PKG_URL!, clientHeader)) as string;
    if (storedKey !== pk) {
      await browser.storage.local.set({ [PK_STORAGE_KEY]: pk });
    }
    return pk;
  } catch (e) {
    console.warn(
      `[PostGuard] Failed to fetch public key from PKG, falling back to cache: ${e}`
    );
    if (storedKey) return storedKey;
    throw new Error("No public key available");
  }
}

// Fetch verification key for signature verification
export async function fetchVerificationKey(): Promise<string> {
  return (await fetchVK(PKG_URL!, clientHeader)) as string;
}

export { PKG_URL };
