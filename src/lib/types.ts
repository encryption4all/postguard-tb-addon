export interface AttributeRequest {
  t: string;
  v: string;
}

export type AttributeCon = AttributeRequest[];

export type Policy = Record<string, AttributeCon>;

export type KeySort = "Decryption" | "Signing";

export interface PopupData {
  hostname: string;
  header: Record<string, string>;
  con: AttributeCon;
  sort: KeySort;
  hints?: AttributeCon;
  senderId?: string;
}

export interface Badge {
  type: string;
  value: string;
}

export interface SessionStartResult {
  sessionPtr: {
    u: string;
    irmaqr: string;
  };
  token: string;
}
