import { generateBoundary } from "./utils";

interface MimeInput {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  plainTextBody: string;
  isPlainText: boolean;
  date: Date;
  attachments: Array<{
    name: string;
    type: string;
    data: ArrayBuffer;
  }>;
}

export function buildInnerMime(input: MimeInput): Uint8Array {
  const {
    from,
    to,
    cc,
    subject,
    body,
    plainTextBody,
    isPlainText,
    date,
    attachments,
  } = input;

  const hasAttachments = attachments.length > 0;
  let bodyContentType = `${isPlainText ? "text/plain" : "text/html"}; charset=utf-8`;
  let boundary = "";

  if (hasAttachments) {
    boundary = generateBoundary();
  }

  const contentType = hasAttachments
    ? `multipart/mixed; boundary="${boundary}"`
    : bodyContentType;

  let mime = "";
  mime += `Date: ${date.toUTCString()}\r\n`;
  mime += "MIME-Version: 1.0\r\n";
  mime += `To: ${to.join(", ")}\r\n`;
  mime += `From: ${from}\r\n`;
  mime += `Subject: ${subject}\r\n`;
  if (cc.length > 0) mime += `Cc: ${cc.join(", ")}\r\n`;
  mime += `Content-Type: ${contentType}\r\n`;
  mime += "X-PostGuard: 0.1\r\n";
  mime += "\r\n";

  const bodyText = isPlainText ? plainTextBody : body;

  if (hasAttachments) {
    mime += `--${boundary}\r\nContent-Type: ${bodyContentType}\r\n\r\n`;
    mime += bodyText;
    mime += "\r\n";

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const isLast = i === attachments.length - 1;
      const b64 = arrayBufferToBase64(att.data);
      const formatted = b64.replace(/(.{76})/g, "$1\r\n");

      mime += `--${boundary}\r\nContent-Type: ${att.type}; name="${att.name}"\r\n`;
      mime += `Content-Disposition: attachment; filename="${att.name}"\r\n`;
      mime += "Content-Transfer-Encoding: base64\r\n\r\n";
      mime += formatted;
      mime += isLast ? `\r\n--${boundary}--\r\n` : "\r\n";
    }
  } else {
    mime += bodyText;
  }

  return new TextEncoder().encode(mime);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
