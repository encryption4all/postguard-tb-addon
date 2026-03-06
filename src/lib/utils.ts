import type { AttributeCon, AttributeRequest } from "./types";

export function toEmail(identity: string): string {
  const match = identity.match(/^(.*)<(.*)>$/);
  return (match ? match[2] : identity).toLowerCase();
}

export function generateBoundary(): string {
  const rand = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashCon(con: AttributeCon): Promise<string> {
  const sorted = [...con].sort(
    (a: AttributeRequest, b: AttributeRequest) =>
      a.t.localeCompare(b.t) || (a.v ?? "").localeCompare(b.v ?? "")
  );
  return hashString(JSON.stringify(sorted));
}

export async function hashString(message: string): Promise<string> {
  const data = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

// If hours < 4: seconds till 4 AM today.
// If hours >= 4: seconds till 4 AM tomorrow.
export function secondsTill4AM(): number {
  const now = Date.now();
  const nextMidnight = new Date(now).setHours(24, 0, 0, 0);
  const secondsTillMidnight = Math.round((nextMidnight - now) / 1000);
  return (secondsTillMidnight + 4 * 60 * 60) % (24 * 60 * 60);
}

export function typeToImage(t: string): string {
  switch (t) {
    case "pbdf.sidn-pbdf.email.email":
      return "envelope";
    case "pbdf.sidn-pbdf.mobilenumber.mobilenumber":
      return "phone";
    case "pbdf.pbdf.surfnet-2.id":
      return "education";
    case "pbdf.nuts.agb.agbcode":
      return "health";
    case "pbdf.gemeente.personalData.dateofbirth":
      return "calendar";
    default:
      return "personal";
  }
}

export const EMAIL_ATTRIBUTE_TYPE = "pbdf.sidn-pbdf.email.email";
