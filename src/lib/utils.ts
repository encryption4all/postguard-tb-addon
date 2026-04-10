// Thunderbird-specific utility functions.
// Armor, MIME, and policy utilities are now in @e4a/pg-js.

export function toEmail(identity: string): string {
  const match = identity.match(/^(.*)<(.*)>$/);
  return (match ? match[2] : identity).toLowerCase();
}

export const EMAIL_ATTRIBUTE_TYPE = "pbdf.sidn-pbdf.email.email";

export function findHtmlBody(part: { contentType?: string; body?: string; parts?: any[] }): string | null {
  if (part.contentType === "text/html" && part.body) return part.body;
  if (part.parts) {
    for (const sub of part.parts) {
      const found = findHtmlBody(sub);
      if (found) return found;
    }
  }
  return null;
}
