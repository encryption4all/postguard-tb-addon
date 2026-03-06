// Decryption wrapper around @e4a/pg-wasm StreamUnsealer

import type { AttributeRequest, SenderIdentity } from "./types";

export interface UnsealResult {
  plaintext: string;
  senderIdentity: SenderIdentity;
}

// Module-level reference, set at startup
let StreamUnsealerClass: any = null;

export function setStreamUnsealer(cls: any) {
  StreamUnsealerClass = cls;
}

export async function unsealData(
  ciphertext: File,
  verificationKey: string,
  recipientId: string,
  usk: unknown
): Promise<UnsealResult> {
  if (!StreamUnsealerClass) {
    throw new Error("pg-wasm StreamUnsealer not initialized");
  }

  const readable = ciphertext.stream();
  const unsealer = await StreamUnsealerClass.new(readable, verificationKey);

  let plaintext = "";
  const decoder = new TextDecoder();
  const writable = new WritableStream({
    write(chunk: Uint8Array) {
      plaintext += decoder.decode(chunk, { stream: true });
    },
    close() {
      plaintext += decoder.decode();
    },
  });

  const tStart = performance.now();
  const senderIdentity = await unsealer.unseal(recipientId, usk, writable);
  console.log(
    `[PostGuard] Decryption took ${(performance.now() - tStart).toFixed(0)}ms`
  );

  return { plaintext, senderIdentity };
}

export function inspectHeader(
  unsealer: any
): Map<string, { ts: number; con: AttributeRequest[] }> {
  return unsealer.inspect_header();
}
