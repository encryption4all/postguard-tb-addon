// Placeholder body for the encrypted email envelope
// This is what recipients see if their client doesn't support PostGuard

import {
  armorBase64,
  toUrlSafeBase64,
  PG_ARMOR_DIV_ID,
  POSTGUARD_WEBSITE_URL,
  PG_MAX_URL_FRAGMENT_SIZE,
} from "./utils";

export function getPlaceholderHtml(from: string, base64Encrypted?: string): string {
  const fallbackLink = base64Encrypted ? buildFallbackLink(base64Encrypted) : "";
  const armorDiv = base64Encrypted ? buildArmorDiv(base64Encrypted) : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; color: #022E3D;">
  <div style="max-width: 600px; margin: 0 auto; text-align: center; padding: 40px 20px;">
    <h2 style="color: #022E3D; margin-bottom: 16px;">PostGuard Encrypted Email</h2>
    <p style="color: #4b5563; margin-bottom: 24px;">
      This email from <strong>${escapeHtml(from)}</strong> is encrypted using PostGuard.
    </p>
    <p style="color: #6b7280; font-size: 14px;">
      To decrypt this message, you need the PostGuard extension for Thunderbird.
      Visit <a href="https://postguard.eu" style="color: #006EF4;">postguard.eu</a> for more information.
    </p>${fallbackLink}
  </div>${armorDiv}
</body>
</html>`;
}

export function getPlaceholderText(from: string): string {
  return `PostGuard Encrypted Email

This email from ${from} is encrypted using PostGuard.
To decrypt this message, you need the PostGuard extension for Thunderbird.
Visit https://postguard.eu for more information.`;
}

function buildFallbackLink(base64Encrypted: string): string {
  if (base64Encrypted.length <= PG_MAX_URL_FRAGMENT_SIZE) {
    const urlSafe = toUrlSafeBase64(base64Encrypted);
    const fallbackUrl = `${POSTGUARD_WEBSITE_URL}/decrypt#${urlSafe}`;
    return `
    <p style="color: #6b7280; font-size: 14px; margin-top: 16px;">
      Or <a href="${fallbackUrl}" style="color: #006EF4;">decrypt in your browser</a>
      without installing any add-on.
    </p>`;
  }
  return `
    <p style="color: #6b7280; font-size: 14px; margin-top: 16px;">
      Or decrypt in your browser via
      <a href="${POSTGUARD_WEBSITE_URL}/decrypt" style="color: #006EF4;">postguard.eu/decrypt</a>.
      Upload the attached <code>postguard.encrypted</code> file on that page.
    </p>`;
}

function buildArmorDiv(base64Encrypted: string): string {
  return `\n  <div id="${PG_ARMOR_DIV_ID}" style="display:none;font-size:0;max-height:0;overflow:hidden;mso-hide:all">${armorBase64(base64Encrypted)}</div>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
