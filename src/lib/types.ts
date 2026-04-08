export interface AttributeRequest {
  t: string;
  v: string;
}

export type AttributeCon = AttributeRequest[];

export type Policy = Record<string, AttributeCon>;

export interface Badge {
  type: string;
  value: string;
}

// --- Crypto popup messaging types ---

export interface CryptoPopupConfig {
  pkgUrl: string;
  cryptifyUrl?: string;
  headers?: Record<string, string>;
}

export interface SerializedRecipient {
  type: "email" | "emailDomain" | "customPolicy";
  email: string;
  policy?: { t: string; v: string }[];
}

export interface EncryptPopupData {
  operation: "encrypt";
  config: CryptoPopupConfig;
  mimeDataBase64: string;
  recipients: SerializedRecipient[];
  senderEmail: string;
  from: string;
  websiteUrl?: string;
}

export interface DecryptPopupData {
  operation: "decrypt";
  config: CryptoPopupConfig;
  ciphertextBase64: string;
  recipientEmail: string;
}

export type CryptoPopupInitData = EncryptPopupData | DecryptPopupData;

export interface EncryptPopupResult {
  operation: "encrypt";
  subject: string;
  htmlBody: string;
  plainTextBody: string;
  attachmentBase64: string;
  attachmentSize: number;
}

export interface DecryptPopupResult {
  operation: "decrypt";
  plaintextBase64: string;
  sender: { email: string | null; attributes: { type: string; value?: string }[] } | null;
}

export type CryptoPopupResult = EncryptPopupResult | DecryptPopupResult;
