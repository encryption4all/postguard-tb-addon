// Thunderbird-specific utility functions.
// Armor, MIME, and policy utilities are now in @e4a/pg-js.

export function toEmail(identity: string): string {
  const match = identity.match(/^(.*)<(.*)>$/);
  return (match ? match[2] : identity).toLowerCase();
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
