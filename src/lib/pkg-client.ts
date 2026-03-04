import type { AttributeCon, SessionStartResult } from "./types";

const PKG_URL = "https://postguard-main.cs.ru.nl/pkg";
const PK_STORAGE_KEY = "pg-pk";

let clientHeader: Record<string, string> = {};

export function setClientHeader(header: Record<string, string>) {
  clientHeader = header;
}

// Fetch master public key with localStorage fallback
export async function fetchPublicKey(): Promise<string> {
  const stored = await browser.storage.local.get(PK_STORAGE_KEY);
  const storedKey = stored[PK_STORAGE_KEY] as string | undefined;

  try {
    const resp = await fetch(`${PKG_URL}/v2/parameters`, {
      headers: clientHeader,
    });
    const { publicKey } = await resp.json();
    if (storedKey !== publicKey) {
      await browser.storage.local.set({ [PK_STORAGE_KEY]: publicKey });
    }
    return publicKey;
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
  const resp = await fetch(`${PKG_URL}/v2/sign/parameters`, {
    headers: clientHeader,
  });
  const { publicKey } = await resp.json();
  return publicKey;
}

// Start a Yivi session for key retrieval
export async function startSession(
  con: AttributeCon,
  sort: string
): Promise<SessionStartResult> {
  const resp = await fetch(`${PKG_URL}/v2/request/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...clientHeader,
    },
    body: JSON.stringify({ con, sort }),
  });
  return resp.json();
}

// Get JWT result (returned as plain text by PKG)
export async function getSessionJwt(token: string): Promise<string> {
  const resp = await fetch(`${PKG_URL}/v2/request/jwt/${token}`, {
    headers: clientHeader,
  });
  return resp.text();
}

// Retrieve a USK (User Secret Key) using a JWT
export async function getUSK(jwt: string, timestamp: number): Promise<unknown> {
  const resp = await fetch(`${PKG_URL}/v2/irma/key/${timestamp}`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...clientHeader,
    },
  });
  const json = await resp.json();
  if (json.status !== "DONE" || json.proofStatus !== "VALID") {
    throw new Error("PKG session not DONE and VALID");
  }
  return json.key;
}

// Retrieve signing keys using a JWT
export async function getSigningKeys(
  jwt: string,
  keyRequest?: object
): Promise<{ pubSignKey: unknown; privSignKey?: unknown }> {
  const resp = await fetch(`${PKG_URL}/v2/irma/sign/key`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
      ...clientHeader,
    },
    body: JSON.stringify(keyRequest),
  });
  const json = await resp.json();
  if (json.status !== "DONE" || json.proofStatus !== "VALID") {
    throw new Error("PKG signing session not DONE and VALID");
  }
  return { pubSignKey: json.pubSignKey, privSignKey: json.privSignKey };
}

export { PKG_URL };
