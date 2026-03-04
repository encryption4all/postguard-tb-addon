// Placeholder body for the encrypted email envelope
// This is what recipients see if their client doesn't support PostGuard

export function getPlaceholderHtml(from: string): string {
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
    </p>
  </div>
</body>
</html>`;
}

export function getPlaceholderText(from: string): string {
  return `PostGuard Encrypted Email

This email from ${from} is encrypted using PostGuard.
To decrypt this message, you need the PostGuard extension for Thunderbird.
Visit https://postguard.eu for more information.`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
