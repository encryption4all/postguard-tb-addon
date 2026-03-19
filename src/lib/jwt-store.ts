/// <reference path="../types/thunderbird.d.ts" />

// import { hashCon } from "./utils";
// import type { AttributeCon } from "./types";

// // Check localStorage for a cached JWT
// export async function checkLocalJwt(con: AttributeCon): Promise<string> {
//   const hash = await hashCon(con);
//   const cached = await browser.storage.local.get(hash);
//   if (Object.keys(cached).length === 0) throw new Error("Not in cache");
//   const entry = cached[hash] as { jwt: string; exp: number };
//   if (Date.now() / 1000 > entry.exp) {
//     await browser.storage.local.remove(hash);
//     throw new Error("JWT expired");
//   }
//   return entry.jwt;
// }


// // Store a JWT in localStorage
// export async function storeLocalJwt(
//   con: AttributeCon,
//   jwt: string
// ): Promise<void> {
//   const hash = await hashCon(con);
//   const parts = jwt.split(".");
//   if (parts.length !== 3) return;
//   try {
//     const payload = JSON.parse(atob(parts[1]));
//     await browser.storage.local.set({
//       [hash]: { jwt, exp: payload.exp },
//     });
//   } catch {
//     console.warn("[PostGuard] Failed to decode JWT for storage");
//   }
// }

// // Clean up expired JWTs
// export async function cleanUpJwts(): Promise<void> {
//   const all = await browser.storage.local.get(null);
//   const now = Date.now() / 1000;
//   for (const [key, val] of Object.entries(all)) {
//     if (val && typeof val === "object" && "exp" in (val as object)) {
//       const entry = val as { jwt: string; exp: number };
//       if (now > entry.exp) {
//         await browser.storage.local.remove(key);
//       }
//     }
//   }
// }
