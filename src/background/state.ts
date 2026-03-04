export interface ComposeTabState {
  encrypt: boolean;
  policy?: Policy;
  signId?: Policy;
  configWindowId?: number;
  signWindowId?: number;
  newMsgId?: number;
  sentMimeData?: Uint8Array;
}

export type Policy = Record<string, AttributeCon>;
export type AttributeCon = AttributeRequest[];
export interface AttributeRequest {
  t: string;
  v: string;
}

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

// Per-compose-tab state
export const composeTabs = new Map<number, ComposeTabState>();

// Tracks badges for decrypted messages
export const decryptedMessages = new Map<number, { badges?: Badge[] }>();
